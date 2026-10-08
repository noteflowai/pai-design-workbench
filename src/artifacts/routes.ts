/**
 * HTTP surface of the artifact platform (v1). Every route sits behind the workbench's existing authentication (ALB +
 * Cognito hosted, loopback locally); none is exposed under /api/agent. Writes require a same-origin browser session.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { DomainError } from "../domain.js";
import type { Store } from "../store.js";
import { ADAPTERS, createArtifact, decideArtifact, exportArtifact, getArtifact, importArtifact, sampleInput, verifyArtifactPackage, validateArtifact, type ArtifactVersion } from "./registry.js";
import { decideRun, resumeRun, runData, saveWorkflow, startRun, validateWorkflow, type Workflow, type WorkflowRun } from "./workflows.js";

const Ref = z.string().regex(/^[a-z][a-z0-9-]{1,62}@\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const WorkflowRef = z.string().regex(/^[a-z][a-z0-9-]{1,62}@\d{1,6}$/);
const RunId = z.string().uuid();
const summary = (a: ArtifactVersion) => ({ id: a.id, name: a.manifest.name, version: a.manifest.version, kind: a.manifest.kind, adapter: a.manifest.adapter,
  title: a.manifest.title, state: a.state, digest: a.digest, origin: a.origin, validated: a.validation ? { at: a.validation.at, passed: a.validation.passed } : null,
  operations: a.manifest.operations.map(o => o.id) });

type Execute = <T extends { id: string; state: string }>(reply: FastifyReply, input: unknown, kind: string, route: string, execute: () => Promise<T>) => Promise<T>;
export function artifactRoutes(app: FastifyInstance, d: { store: Store; config: Config; actor: (h: Record<string, unknown>) => string; executeNative: Execute }) {
  const { store, config } = d;
  const param = (p: unknown, schema: z.ZodType<string>, field = "id") => schema.parse((p as Record<string, unknown>)[field]);
  const soft = <T>(f: () => T) => {
    try { return f(); } catch (e) { if (e instanceof DomainError) return { valid: false, error: e.code, message: e.message }; throw e; }
  };
  app.get("/api/v1/artifacts", async () => ({ adapters: Object.keys(ADAPTERS), artifacts: store.list<ArtifactVersion>("artifact").map(summary) }));
  app.get("/api/v1/artifacts/:id", async request => getArtifact(store, param(request.params, Ref)));
  app.post("/api/v1/artifacts", async request => createArtifact(store, config, request.body, d.actor(request.headers)));
  app.post("/api/v1/artifacts/:id/validation", async request => validateArtifact(store, config, param(request.params, Ref), d.actor(request.headers)));
  app.post("/api/v1/artifacts/:id/lifecycle", async request => decideArtifact(store, param(request.params, Ref), request.body, d.actor(request.headers)));
  app.post("/api/v1/artifacts/:id/samples", async request => sampleInput(store, config, param(request.params, Ref), request.body));
  app.get("/api/v1/artifacts/:id/package", async (request, reply) => {
    const id = param(request.params, Ref);
    const pkg = await exportArtifact(store, config, id);
    reply.header("Content-Disposition", `attachment; filename="pai-artifact-${id.replace("@", "-")}.json"`);
    return pkg;
  });
  /** Offline-equivalent verification; pin the expected signer with `trustedPublicKeyPem` (GET /api/signing/public-key). */
  app.post("/api/v1/artifact-packages/verification", async request => {
    const body = z.object({ package: z.unknown(), trustedPublicKeyPem: z.string().max(4000).optional() }).strict().parse(request.body);
    return soft(() => verifyArtifactPackage(body.package, body.trustedPublicKeyPem));
  });
  app.post("/api/v1/artifact-packages", async request => importArtifact(store, config, request.body, d.actor(request.headers)));

  app.get("/api/v1/workflows", async () => store.list<Workflow>("workflow"));
  app.get("/api/v1/workflows/:id", async request => {
    const w = store.get<Workflow>("workflow", param(request.params, WorkflowRef));
    if (!w) throw new DomainError("NOT_FOUND", "Workflow not found", 404);
    return w;
  });
  /** Dry validation of a definition; the editor checks before saving. */
  app.post("/api/v1/workflow-validation", async request => soft(() => ({ valid: true, order: validateWorkflow(store, request.body).order })));
  app.post("/api/v1/workflows", async request => saveWorkflow(store, request.body, d.actor(request.headers)));
  app.get("/api/v1/workflow-runs", async () => store.list<WorkflowRun>("workflow-run").reverse().slice(0, 50));
  const getRun = (p: unknown) => {
    const r = store.get<WorkflowRun>("workflow-run", param(p, RunId));
    if (!r) throw new DomainError("NOT_FOUND", "Workflow run not found", 404);
    return r;
  };
  app.get("/api/v1/workflow-runs/:id", async request => getRun(request.params));
  app.get("/api/v1/workflow-runs/:id/data", async request => {
    const q = z.object({ node: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional(), name: z.string().regex(/^[a-z][A-Za-z0-9]{0,30}$/) }).strict().parse(request.query);
    return runData(config, getRun(request.params), q);
  });
  app.post("/api/v1/workflow-runs", async (request, reply) =>
    d.executeNative(reply, request.body, "workflow-run", "v1/workflow-runs", () => startRun({ store, config }, request.body, d.actor(request.headers))));
  app.post("/api/v1/workflow-runs/:id/decisions", async request => decideRun({ store, config }, getRun(request.params).id, request.body, d.actor(request.headers)));
  app.post("/api/v1/workflow-runs/:id/resume", async request => resumeRun({ store, config }, getRun(request.params).id));
}
