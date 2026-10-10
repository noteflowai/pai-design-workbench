/**
 * Business-process orchestration over artifacts (pai-workflow-1): a workflow is validated JSON, not code.
 *
 * Nodes:
 * - `artifact`: one operation of an exact artifact version (`name@x.y.z`, validated or released, never draft or
 *   deprecated). Inputs are references `$input.<name>` or `$<node>.<output>`; their data schema ids must match.
 * - `condition`: passes when a referenced node's status is in `pass`; otherwise the run ends `rejected` (a business
 *   outcome, kept with all evidence) or, with `onFail: "review"`, waits for a person.
 * - `approval`: waits for a named person's decision; approve continues, reject ends the run.
 * Validation refuses unknown fields, duplicate ids, unresolved references, type mismatches, unknown operations or
 * parameters, and cycles, before anything runs.
 *
 * Running: nodes execute in dependency order; each node keeps its outputs' digests, status, receipts and usage.
 * Nothing is retried. After a restart a node left `running` is resumed only if its operation declares no external
 * effects; any other effect would need reconciliation first. Run identity: one requestId, one run.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { canonical, DomainError, sha256 } from "../domain.js";
import type { Store } from "../store.js";
import { ArtifactRef, type Usage } from "./contract.js";
import { adapterOf, getArtifact, runOperation, usageRecord, type ArtifactVersion } from "./registry.js";

const NodeId = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const Ref = z.string().regex(/^\$(input|[a-z][a-z0-9-]{0,30})\.[a-z][A-Za-z0-9]{0,30}$/, "reference $input.<name> or $<node>.<output>");
const ArtifactNode = z.object({ id: NodeId, type: z.literal("artifact"), artifact: ArtifactRef, operation: z.string(),
  inputs: z.record(z.string(), Ref), params: z.record(z.string(), z.unknown()).default({}), after: z.array(NodeId).default([]) }).strict();
const ConditionNode = z.object({ id: NodeId, type: z.literal("condition"), status: z.string().regex(/^\$[a-z][a-z0-9-]{0,30}$/, "status of a node: $<node>"),
  pass: z.array(z.string()).min(1), onFail: z.enum(["reject", "review"]).default("reject"), after: z.array(NodeId).default([]) }).strict();
const ApprovalNode = z.object({ id: NodeId, type: z.literal("approval"), prompt: z.string().max(400), after: z.array(NodeId).default([]) }).strict();
export const WorkflowNode = z.discriminatedUnion("type", [ArtifactNode, ConditionNode, ApprovalNode]);
export const WorkflowDefinition = z.object({
  schema: z.literal("pai-workflow-1"), name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/), version: z.number().int().positive(),
  title: z.string().max(120), description: z.string().max(1000).default(""),
  inputs: z.record(z.string(), z.object({ schema: z.string() }).strict()),
  nodes: z.array(WorkflowNode).min(1).max(30),
  outputs: z.record(z.string(), Ref),
}).strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
type Node = z.infer<typeof WorkflowNode>;

export interface Workflow { id: string; revision: number; tenant: string; definition: WorkflowDefinition; digest: string; createdAt: string; createdBy: string }
export type NodeState = "pending" | "running" | "succeeded" | "failed" | "waiting-approval" | "skipped" | "rejected";
export interface NodeRun {
  state: NodeState; status?: string; error?: string; startedAt?: string; finishedAt?: string;
  outputs?: Record<string, { sha256: string; file: string }>; receipts?: unknown[]; usage?: Usage; decision?: { by: string; at: string; approve: boolean; reason: string };
}
export interface WorkflowRun {
  id: string; revision: number; tenant: string; requestId: string; workflowId: string; workflowDigest: string; inputDigest: string;
  state: "running" | "waiting-approval" | "succeeded" | "rejected" | "failed" | "interrupted"; nodes: Record<string, NodeRun>;
  /** Digest of every artifact version pinned at start; a node runs only if its version still has this digest. */
  artifacts: Record<string, string>;
  outputs?: Record<string, { sha256: string; file: string }>; createdAt: string; finishedAt?: string; createdBy: string; error?: string;
}

const refNode = (ref: string) => ref.slice(1).split(".")[0];
const refName = (ref: string) => ref.split(".")[1];
const deps = (n: Node) => [...new Set([...(n.after ?? []), ...(n.type === "artifact" ? Object.values(n.inputs).map(refNode).filter(x => x !== "input") : []),
  ...(n.type === "condition" ? [n.status.slice(1)] : [])])];

/** Validate a definition against the registry; returns the nodes in execution order. Throws with every problem found. */
export function validateWorkflow(store: Store, input: unknown, opts: { started?: boolean } = {}): { definition: WorkflowDefinition; order: string[]; artifacts: Record<string, ArtifactVersion> } {
  const parsed = WorkflowDefinition.safeParse(input);
  if (!parsed.success) throw new DomainError("WORKFLOW_SCHEMA", parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), 422);
  const def = parsed.data, problems: string[] = [];
  const byId = new Map<string, Node>();
  for (const n of def.nodes) { if (byId.has(n.id) || n.id === "input") problems.push(`duplicate or reserved node id ${n.id}`); byId.set(n.id, n); }
  const artifacts: Record<string, ArtifactVersion> = {};
  const outputSchema = (ref: string): string | undefined => {
    const src = refNode(ref), name = refName(ref);
    if (src === "input") return def.inputs[name]?.schema;
    const n = byId.get(src);
    if (!n || n.type !== "artifact") return undefined;
    const a = artifacts[n.artifact];
    return a?.manifest.operations.find(o => o.id === n.operation)?.outputs[name];
  };
  for (const n of def.nodes) if (n.type === "artifact" && !artifacts[n.artifact]) {
    const a = store.get<ArtifactVersion>("artifact", n.artifact);
    if (!a) problems.push(`${n.id}: artifact ${n.artifact} not found`);
    // A started run keeps its pinned versions (checked by digest per node); new runs need validated or released ones.
    else if (!opts.started && a.state !== "validated" && a.state !== "released") problems.push(`${n.id}: artifact ${n.artifact} is ${a.state}; only validated or released versions can be used`);
    else artifacts[n.artifact] = a;
  }
  for (const n of def.nodes) {
    for (const d of deps(n)) if (!byId.has(d)) problems.push(`${n.id}: depends on unknown node ${d}`);
    if (n.type !== "artifact" || !artifacts[n.artifact]) continue;
    const op = artifacts[n.artifact].manifest.operations.find(o => o.id === n.operation);
    if (!op) { problems.push(`${n.id}: ${n.artifact} has no operation ${n.operation}`); continue; }
    for (const [name, schema] of Object.entries(op.inputs)) {
      const ref = n.inputs[name];
      if (!ref) { problems.push(`${n.id}: input ${name} (${schema}) is not wired`); continue; }
      const got = outputSchema(ref);
      if (got !== schema) problems.push(`${n.id}: input ${name} needs ${schema} but ${ref} is ${got ?? "unresolved"}`);
    }
    for (const extra of Object.keys(n.inputs)) if (!op.inputs[extra]) problems.push(`${n.id}: ${n.operation} has no input ${extra}`);
    const params = adapterOf(artifacts[n.artifact].manifest.adapter).params[n.operation]?.safeParse(n.params);
    if (params && !params.success) problems.push(`${n.id}: params ${params.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  for (const [name, ref] of Object.entries(def.outputs)) if (!outputSchema(ref)) problems.push(`output ${name}: ${ref} is unresolved`);
  // Topological order (Kahn); anything left over is a cycle.
  const indeg = new Map(def.nodes.map(n => [n.id, deps(n).filter(d => byId.has(d)).length]));
  const order: string[] = [], queue = def.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  while (queue.length) {
    const id = queue.shift()!; order.push(id);
    for (const n of def.nodes) if (deps(n).includes(id)) { indeg.set(n.id, indeg.get(n.id)! - 1); if (indeg.get(n.id) === 0) queue.push(n.id); }
  }
  if (order.length !== def.nodes.length) problems.push(`cycle among ${def.nodes.filter(n => !order.includes(n.id)).map(n => n.id).join(", ")}`);
  if (problems.length) throw new DomainError("WORKFLOW_INVALID", problems.join("; "), 422);
  return { definition: def, order, artifacts };
}

export function saveWorkflow(store: Store, input: unknown, actor: string): Workflow {
  const { definition } = validateWorkflow(store, input);
  const id = `${definition.name}@${definition.version}`, digest = sha256(canonical(definition));
  const existing = store.get<Workflow>("workflow", id);
  if (existing) {
    if (existing.digest !== digest) throw new DomainError("WORKFLOW_IMMUTABLE", `${id} exists with a different definition; save a new version`, 409);
    return existing;
  }
  const w: Workflow = { id, revision: 1, tenant: "workspace", definition, digest, createdAt: new Date().toISOString(), createdBy: actor };
  store.insert("workflow", w);
  return w;
}

export const StartRun = z.object({ requestId: z.string().uuid(), workflow: z.string(), inputs: z.record(z.string(), z.unknown()) }).strict();
type Deps = { store: Store; config: Config };

/** `tenant` defaults to the maintainer workspace; tenant runs come only through src/tenants.ts. */
export async function startRun(d: Deps, input: unknown, actor: string, tenant = "workspace"): Promise<WorkflowRun> {
  const req = StartRun.parse(input);
  const w = d.store.get<Workflow>("workflow", req.workflow);
  if (!w) throw new DomainError("NOT_FOUND", `Workflow ${req.workflow} not found`, 404);
  const { order, artifacts } = validateWorkflow(d.store, w.definition); // re-checked: an artifact may have been deprecated since
  for (const [name, spec] of Object.entries(w.definition.inputs)) {
    const owner = Object.values(artifacts).map(a => adapterOf(a.manifest.adapter)).find(a => a.schemas.includes(spec.schema));
    const problems = owner ? owner.validateData(spec.schema, req.inputs[name]) : [`no artifact in this workflow defines ${spec.schema}`];
    if (problems.length) throw new DomainError("INVALID_INPUT", `${name} (${spec.schema}): ${problems.join("; ")}`, 422);
  }
  for (const extra of Object.keys(req.inputs)) if (!w.definition.inputs[extra]) throw new DomainError("INVALID_INPUT", `Workflow ${w.id} has no input ${extra}`, 422);
  const run: WorkflowRun = { id: randomUUID(), revision: 1, tenant, requestId: req.requestId, workflowId: w.id, workflowDigest: w.digest,
    inputDigest: sha256(JSON.stringify(req.inputs)), state: "running", nodes: Object.fromEntries(order.map(id => [id, { state: "pending" as NodeState }])),
    artifacts: Object.fromEntries(Object.values(artifacts).map(a => [a.id, a.digest])),
    createdAt: new Date().toISOString(), createdBy: actor };
  // The tenant is part of the request identity: reusing another tenant's requestId is a conflict, never its run.
  const identity = tenant === "workspace" ? { kind: "workflow-run", workflow: w.id, inputs: req.inputs } : { kind: "workflow-run", tenant, workflow: w.id, inputs: req.inputs };
  const claimed = d.store.claim(req.requestId, sha256(canonical(identity)), run, "workflow-run");
  if (claimed !== run.id) {
    const existing = d.store.get<WorkflowRun>("workflow-run", claimed)!;
    if (existing.tenant !== tenant) throw new DomainError("REQUEST_CONFLICT", "Request identity cannot be reused for different inputs");
    return existing;
  }
  await writeData(d.config, run.id, "input", req.inputs);
  return advance(d, run.id);
}

const runDir = (config: Config, id: string) => join(config.state, "workflow-runs", id);
async function writeData(config: Config, runId: string, name: string, value: unknown) {
  await mkdir(runDir(config, runId), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value), file = `${name}.json`;
  await writeFile(join(runDir(config, runId), file), text, { mode: 0o600 });
  return { sha256: sha256(text), file };
}
async function readData(config: Config, runId: string, file: string, digest: string) {
  const text = await readFile(join(runDir(config, runId), file), "utf8");
  if (sha256(text) !== digest) throw new DomainError("RUN_DATA", `Stored data ${file} differs from its recorded digest`, 500);
  return JSON.parse(text);
}

/**
 * Any unexpected error ends the run with its reason (never left "running"); nothing is retried. A node that was
 * running an operation with external effects makes the run "interrupted" (reconcile first) instead of "failed".
 */
async function advance(d: Deps, runId: string): Promise<WorkflowRun> {
  try { return await step(d, runId); } catch (e) {
    const error = e instanceof DomainError ? `${e.code}: ${e.message}` : String(e);
    for (let attempt = 0; ; attempt++) {
      const run = d.store.get<WorkflowRun>("workflow-run", runId)!;
      if (run.state !== "running") return run;
      const w = d.store.get<Workflow>("workflow", run.workflowId);
      const effects = Object.entries(run.nodes).some(([k, n]) => n.state === "running" && (() => {
        const node = w?.definition.nodes.find(x => x.id === k);
        const a = node?.type === "artifact" ? d.store.get<ArtifactVersion>("artifact", node.artifact) : undefined;
        return a?.manifest.operations.find(o => node?.type === "artifact" && o.id === node.operation)?.effects !== "none";
      })());
      const nodes = Object.fromEntries(Object.entries(run.nodes).map(([k, n]) => [k, n.state === "running" ? { ...n, state: (effects ? "running" : "failed") as NodeState, error } : n]));
      const ended: WorkflowRun = { ...run, revision: run.revision + 1, state: effects ? "interrupted" : "failed", error, nodes, ...(effects ? {} : { finishedAt: new Date().toISOString() }) };
      try { d.store.put("workflow-run", ended, run.revision); return ended; }
      catch (conflict) { if (attempt >= 2) throw conflict; } // a concurrent update: re-read and record again
    }
  }
}

/** Execute every node that can run now; stops at an approval, a failure or the end. Never re-runs a finished node. */
async function step(d: Deps, runId: string): Promise<WorkflowRun> {
  let run = d.store.get<WorkflowRun>("workflow-run", runId)!;
  const w = d.store.get<Workflow>("workflow", run.workflowId)!;
  const { order } = validateWorkflow(d.store, w.definition, { started: true });
  const inputs = await readData(d.config, run.id, "input.json", run.inputDigest);
  const save = (next: WorkflowRun) => { next.revision = run.revision + 1; d.store.put("workflow-run", next, run.revision); run = next; };
  for (const id of order) {
    const n = w.definition.nodes.find(x => x.id === id)!;
    const state = run.nodes[id];
    if (["succeeded", "skipped"].includes(state.state)) continue;
    if (state.state === "waiting-approval") { save({ ...run, state: "waiting-approval" }); return run; }
    if (["failed", "rejected"].includes(state.state)) break;
    const resolve = async (ref: string) => {
      if (refNode(ref) === "input") return (inputs as Record<string, unknown>)[refName(ref)];
      const o = run.nodes[refNode(ref)].outputs?.[refName(ref)];
      if (!o) throw new DomainError("RUN_DATA", `${ref} has no output`, 500);
      return readData(d.config, run.id, o.file, o.sha256);
    };
    if (n.type === "condition") {
      const status = run.nodes[n.status.slice(1)].status ?? "";
      const ok = n.pass.includes(status);
      if (ok) { save({ ...run, nodes: { ...run.nodes, [id]: { state: "succeeded", status: "pass", finishedAt: new Date().toISOString() } } }); continue; }
      if (n.onFail === "review") { save({ ...run, state: "waiting-approval", nodes: { ...run.nodes, [id]: { state: "waiting-approval", status: `review: ${status}` } } }); return run; }
      save({ ...run, state: "rejected", finishedAt: new Date().toISOString(), error: `${id}: ${n.status.slice(1)} is ${status}, needs ${n.pass.join(" | ")}`,
        nodes: { ...run.nodes, [id]: { state: "rejected", status } } });
      return run;
    }
    if (n.type === "approval") { save({ ...run, state: "waiting-approval", nodes: { ...run.nodes, [id]: { state: "waiting-approval", status: "awaiting decision" } } }); return run; }
    // artifact node
    const a = getArtifact(d.store, n.artifact);
    if (run.artifacts?.[a.id] !== a.digest) throw new DomainError("ARTIFACT_CHANGED", `${a.id} no longer has the digest pinned when the run started`, 409);
    const op = a.manifest.operations.find(o => o.id === n.operation)!;
    if (state.state === "running" && op.effects !== "none") {
      save({ ...run, state: "interrupted", error: `${id} was interrupted and its operation may have external effects; reconcile before resuming` });
      return run;
    }
    const startedAt = new Date().toISOString();
    save({ ...run, nodes: { ...run.nodes, [id]: { state: "running", startedAt } } });
    let result;
    try {
      const values = Object.fromEntries(await Promise.all(Object.entries(n.inputs).map(async ([k, ref]) => [k, await resolve(ref)])));
      const dir = join(runDir(d.config, run.id), "nodes", id);
      await rm(dir, { recursive: true, force: true }); // an effect-free node re-entered after a restart starts clean
      result = await runOperation(d.store, d.config, a, n.operation, values, n.params, dir);
    } catch (e) {
      const error = e instanceof DomainError ? `${e.code}: ${e.message}` : String(e);
      save({ ...run, state: "failed", finishedAt: new Date().toISOString(), error: `${id}: ${error}`, nodes: { ...run.nodes, [id]: { state: "failed", startedAt, finishedAt: new Date().toISOString(), error } } });
      return run;
    }
    const outputs: Record<string, { sha256: string; file: string }> = {};
    for (const [k, v] of Object.entries(result.outputs)) outputs[k] = await writeData(d.config, run.id, `${id}.${k}`, v);
    const usage = usageRecord(run.tenant, `workflow-run:${run.id}`, a.id, id, result.usage);
    const node: NodeRun = { state: result.state === "ok" ? "succeeded" : "failed", status: result.status, error: result.error, startedAt, finishedAt: new Date().toISOString(),
      outputs, receipts: result.receipts, usage };
    if (node.state === "failed") { save({ ...run, state: "failed", finishedAt: new Date().toISOString(), error: `${id}: ${result.error}`, nodes: { ...run.nodes, [id]: node } }); return run; }
    save({ ...run, nodes: { ...run.nodes, [id]: node } });
  }
  if (run.state === "running") {
    const outs: Record<string, { sha256: string; file: string }> = {};
    for (const [k, ref] of Object.entries(w.definition.outputs)) {
      const src = refNode(ref);
      const o = src === "input" ? await writeData(d.config, run.id, `output.${k}`, (inputs as Record<string, unknown>)[refName(ref)]) : run.nodes[src].outputs?.[refName(ref)];
      if (o) outs[k] = o;
    }
    save({ ...run, state: "succeeded", outputs: outs, finishedAt: new Date().toISOString() });
  }
  return run;
}

export const Decision = z.object({ node: NodeId, approve: z.boolean(), reason: z.string().trim().min(5).max(500) }).strict();
/** A person decides a waiting approval (or a condition sent to review); approve continues, reject ends the run. */
export async function decideRun(d: Deps, runId: string, input: unknown, actor: string): Promise<WorkflowRun> {
  const req = Decision.parse(input);
  const run = d.store.get<WorkflowRun>("workflow-run", runId);
  if (!run) throw new DomainError("NOT_FOUND", "Workflow run not found", 404);
  const node = run.nodes[req.node];
  if (!node || node.state !== "waiting-approval") throw new DomainError("INVALID_TRANSITION", `${req.node} is not waiting for a decision`, 409);
  const decision = { by: actor, at: new Date().toISOString(), approve: req.approve, reason: req.reason };
  const next: WorkflowRun = { ...run, revision: run.revision + 1, state: req.approve ? "running" : "rejected", ...(req.approve ? {} : { finishedAt: decision.at, error: `${req.node} rejected by ${actor}` }),
    nodes: { ...run.nodes, [req.node]: { ...node, state: req.approve ? "succeeded" : "rejected", status: req.approve ? "approved" : "rejected", decision } } };
  d.store.put("workflow-run", next, run.revision);
  return req.approve ? advance(d, runId) : next;
}

/** Resume a run interrupted by a restart: only nodes without external effects are re-entered; nothing else is replayed. */
export async function resumeRun(d: Deps, runId: string): Promise<WorkflowRun> {
  const run = d.store.get<WorkflowRun>("workflow-run", runId);
  if (!run) throw new DomainError("NOT_FOUND", "Workflow run not found", 404);
  if (run.state !== "interrupted") throw new DomainError("INVALID_TRANSITION", `Run is ${run.state}`, 409);
  const next = { ...run, revision: run.revision + 1, state: "running" as const, error: undefined };
  d.store.put("workflow-run", next, run.revision);
  return advance(d, runId);
}

export function interruptRunning(store: Store) {
  for (const r of store.list<WorkflowRun>("workflow-run")) if (r.state === "running") {
    store.put("workflow-run", { ...r, revision: r.revision + 1, state: "interrupted", error: "Process restarted; resume re-enters only effect-free nodes" } as WorkflowRun, r.revision);
  }
}

/** The run's data for display: outputs and node outputs, digest-checked. */
export async function runData(config: Config, run: WorkflowRun, ref: { node?: string; name: string }) {
  const o = ref.node ? run.nodes[ref.node]?.outputs?.[ref.name] : run.outputs?.[ref.name];
  if (!o) throw new DomainError("NOT_FOUND", "No such output", 404);
  return readData(config, run.id, o.file, o.sha256);
}
