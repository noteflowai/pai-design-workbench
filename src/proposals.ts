import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runController } from "./controller.js";
import { type Config } from "./config.js";
import { type Project } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { Store } from "./store.js";

export const ProposalInput = z.object({
  requestId: z.uuid(), projectRevision: z.number().int().positive(),
  profiles: z.array(z.enum(["kiro-primary", "kiro-backup", "kiro-backup2", "codex", "claude"])).min(1).max(5),
}).strict();
export interface Proposal {
  id: string; projectId: string; state: string; createdAt: string;
  request: z.infer<typeof ProposalInput>; requirementDigest: string; error?: string;
  report?: unknown; answer?: string; publicationApproved: false; decisionAuthority: false;
}
/** No fresh admission ledger. Native controller owns provider policy, accounting and recovery. */
export async function propose(store: Store, config: Config, project: Project, input: unknown): Promise<Proposal> {
  const request = ProposalInput.parse(input);
  if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Proposal must use the current requirement revision");
  const pending = () => store.list<Proposal>("proposal").find(p => p.projectId === project.id
    && p.request.projectRevision === request.projectRevision
    && p.state !== "done");
  const retained = (previous: Proposal) => {
    if (previous.request.requestId === request.requestId && canonical(previous.request) === canonical(request)) return previous;
    throw new DomainError("PROPOSAL_RECONCILIATION_REQUIRED", "Existing proposal requires controller review; a fresh request or provider cannot bypass its unresolved state or attempt limits");
  };
  const previous = pending();
  if (previous) {
    return retained(previous);
  }
  if (!config.controllerEntrypoint || !config.controllerDatabase) throw new DomainError("CONTROLLER_NOT_CONFIGURED", "Configure the native flow entrypoint and existing reviewed admission ledger", 503);
  await Promise.all([access(config.controllerEntrypoint), access(config.controllerDatabase)]);
  const concurrent = pending();
  if (concurrent) return retained(concurrent);
  const record: Proposal = { id: randomUUID(), projectId: project.id, state: "running",
    createdAt: new Date().toISOString(), request, requirementDigest: sha256(canonical(project.requirements)),
    publicationApproved: false, decisionAuthority: false };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "proposal", project, request })), record, "proposal");
  if (claimed !== record.id) return store.get<Proposal>("proposal", claimed)!;
  const directory = join(config.state, "proposals", record.id);
  try {
    const prompt = `Return a text-only experiment design proposal. Do not invoke tools or publish anything.
Task: ${project.title}
Decision: ${project.intendedDecision}
Frozen requirements: ${canonical(project.requirements)}
Scope: recorded SmolVLA LIBERO task-0, 10 paired seeds, conditions reference/camera/dim.
Explain candidate mechanism, confounders, failure preservation and additional experiment needs.
Do not invent results or certify industrial safety. Proposals have no acceptance authority.`;
    const r = await runController(config, directory, `pai-${record.id}`, prompt, { profiles: request.profiles, timeoutSeconds: 60 });
    record.report = { action: r.action, reason: r.reason, flowStatus: r.flowStatus, engine: r.engine, attempts: r.attempts, effects: r.effects, reportSha256: r.reportSha256 };
    record.state = r.action;
    record.answer = r.answer;
    // An answer is a proposal; a reconcile outcome cannot authorize replay or acceptance.
  } catch {
    record.state = "reconcile"; record.error = "Native execution did not establish completion. Retain identity and inspect native receipts; no automatic replay.";
  }
  store.put("proposal", record);
  return record;
}
