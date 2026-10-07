import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { DomainError, sha256 } from "./domain.js";
import { invokeRuntime } from "./agentcore.js";

/**
 * Bounded invocation of the existing NoteFlow text executor (acpx FlowRunner + Python admission).
 * The executor owns engine routing (Kiro primary → backup → backup2 → Codex → Claude), the reviewed
 * attempt ledger, single-use dispatch and crash recovery. PAI only writes the request and prompt,
 * reads the final report and the per-attempt receipts, and never retries an uncertain run.
 */
export const PROFILES = ["kiro-primary", "kiro-backup", "kiro-backup2", "codex", "claude"] as const;
export type Profile = typeof PROFILES[number];
export const PROVIDER: Record<Profile, "kiro" | "codex" | "claude"> = {
  "kiro-primary": "kiro", "kiro-backup": "kiro", "kiro-backup2": "kiro", codex: "codex", claude: "claude",
};
export type ControllerAction = "done" | "reconcile" | "checkpoint" | "repair" | "deferred-budget" | "blocked-policy" | "blocked-engine";
/** Outcomes where no engine effect can be outstanding. Everything else needs a human reconciliation. */
export const SETTLED: ReadonlySet<string> = new Set(["done", "deferred-budget", "blocked-policy", "blocked-engine"]);
export interface ControllerAttempt {
  profile: string; provider: string; status: string; errorKind: string | null; effects: string;
  model: string | null; engineVersion: string | null; modelEvidence: string | null; answered: boolean;
}
export interface ControllerResult {
  runId: string; action: ControllerAction; reason: string; flowStatus: string; exitCode: number;
  answer?: string; effects?: string; attempts: ControllerAttempt[];
  engine?: { profile: string; provider: string; model: string | null; engineVersion: string | null; modelEvidence: string | null };
  reportSha256: string;
}

const Report = z.object({
  flow_status: z.string(),
  report: z.object({
    schema_version: z.literal(1), run_id: z.string(), action: z.enum(["done", "reconcile", "checkpoint", "repair", "deferred-budget", "blocked-policy", "blocked-engine"]),
    reason: z.string().default(""), publication_approved: z.literal(false),
    result: z.object({
      answer: z.string().nullable().optional(), effects: z.string().optional(),
      requested: z.object({ profile: z.string() }).passthrough().optional(),
      observed: z.object({ model: z.string().nullable().optional(), engine_version: z.string().nullable().optional(), model_evidence: z.string().nullable().optional() }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();
const Receipt = z.object({
  attempt_id: z.string(), status: z.string(), effects: z.string().optional(), answer: z.string().nullable().optional(),
  error: z.object({ kind: z.string().nullable().optional() }).passthrough().nullable().optional(),
  requested: z.object({ profile: z.string() }).passthrough(),
  observed: z.object({ model: z.string().nullable().optional(), engine_version: z.string().nullable().optional(), model_evidence: z.string().nullable().optional() }).passthrough().optional(),
}).passthrough();

/** Local executor (entrypoint + reviewed ledger) or the AgentCore agent runtime (executor and ledger run there). */
export function controllerConfigured(config: Config) { return Boolean((config.controllerEntrypoint && config.controllerDatabase) || config.agentcoreAgentArn); }
/** Profiles the AgentCore agent runtime enables (Kiro only; Codex/Claude need personal credentials). */
/**
 * AgentCore default: the Kiro accounts. Codex and Claude (Bedrock, execution role) are offered only when the
 * deployment lists them in PAI_AI_PROFILES; the runtime itself also refuses engines its ledger policy lacks.
 */
export const REMOTE_PROFILES: readonly Profile[] = ["kiro-primary", "kiro-backup", "kiro-backup2"];
export const controllerTransport = (config: Config): "local" | "agentcore" | undefined =>
  config.controllerEntrypoint && config.controllerDatabase ? "local" : config.agentcoreAgentArn ? "agentcore" : undefined;
/** Engines this deployment may use, in reviewed fallback order. */
export function enabledProfiles(config: Config): Profile[] {
  if (config.aiProfiles) return PROFILES.filter(p => config.aiProfiles!.includes(p));
  return [...(controllerTransport(config) === "agentcore" ? REMOTE_PROFILES : PROFILES)];
}

/** Read the executor's own per-attempt receipts (read-only) to show the actual fallback chain. */
export async function readAttempts(stateDir: string, runId: string): Promise<ControllerAttempt[]> {
  const dir = join(stateDir, "runs", runId);
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return []; }
  const out: ControllerAttempt[] = [];
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    try {
      const r = Receipt.parse(JSON.parse(await readFile(join(dir, name), "utf8")));
      const profile = r.requested.profile;
      out.push({ profile, provider: PROVIDER[profile as Profile] ?? "unknown", status: r.status, errorKind: r.error?.kind ?? null,
        effects: r.effects ?? "unknown", model: r.observed?.model ?? null, engineVersion: r.observed?.engine_version ?? null,
        modelEvidence: r.observed?.model_evidence ?? null, answered: typeof r.answer === "string" && r.answer.length > 0 });
    } catch { /* A receipt still being written is skipped; the final report remains authoritative. */ }
  }
  return out.sort((a, b) => PROFILES.indexOf(a.profile as Profile) - PROFILES.indexOf(b.profile as Profile));
}

/**
 * The per-attempt bound of the pinned executor, read from its own request contract (one source; never hardcoded
 * here). Falls back to the historical 60 s if the contract cannot be read.
 */
export async function attemptBound(config: Config): Promise<number> {
  try {
    const schema = JSON.parse(await readFile(join(await realpath(config.controlRoot), "contracts/text-proposal.schema.json"), "utf8"));
    const max = schema?.properties?.timeout_seconds?.maximum;
    return Number.isInteger(max) && max >= 1 && max <= 600 ? max : 60;
  } catch { return 60; }
}

/**
 * Provider routing for engines that run on Amazon Bedrock (the Claude adapter reads only its process environment, never
 * ~/.claude/settings.json). Scoped to the executor process, so the workbench's own AWS clients keep their region.
 * PAI_CLAUDE_BEDROCK_REGION=us-east-1 → CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION=us-east-1 for the executor only.
 */
export function engineEnv(config: Config): Record<string, string> {
  return config.claudeBedrockRegion ? { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: config.claudeBedrockRegion } : {};
}

/** Outcome of settling one executor attempt after a human reconciliation (executor `reconcile`). */
export interface Settlement { attemptId: string; profile: string; state: "reconciled" | "already-reconciled" | "refused" | "failed"; blockers?: string[] }
/** Whether the pinned executor offers operator reconciliation (noteflow-agent-control#153). */
export async function executorReconciles(config: Config): Promise<boolean> {
  try { return (await readFile(join(await realpath(config.controlRoot), "agent_control/executor.py"), "utf8")).includes("operator-effects-reconciliation-v1"); }
  catch { return false; }
}
/** The executor's operator identity pattern; workbench actors (e-mail, "local-maintainer") map onto it. */
export const operatorIdentity = (actor: string) => (actor.replace(/[^A-Za-z0-9._@:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "maintainer").slice(0, 80);

/**
 * Settle every unknown-effect attempt of a run after a maintainer recorded why it is safe. The executor checks the
 * receipt (tool-free, text-only, terminal), writes its immutable overlay and settles its own ledger; the workbench
 * never writes the ledger. Attempts the executor refuses stay uncertain and are reported with their blockers.
 */
export async function settleRun(config: Config, directory: string, runId: string, actor: string, reason: string): Promise<Settlement[]> {
  const who = operatorIdentity(actor);
  if (controllerTransport(config) === "agentcore") {
    const r = await invokeRuntime<{ settled?: Settlement[]; error?: string; message?: string }>(config.agentcoreAgentArn!, { op: "reconcile", run_id: runId, actor: who, reason }, { timeoutMs: 120_000 });
    if (!r.settled) throw new DomainError(r.error ?? "RECONCILE_FAILED", `AgentCore 执行器拒绝核对：${r.message ?? r.error ?? "unknown"}`, 502);
    return r.settled;
  }
  if (!controllerConfigured(config) || !(await executorReconciles(config))) return [];
  const state = join(directory, "native-state"), runs = join(state, "runs", runId);
  let names: string[] = [];
  try { names = await readdir(runs); } catch { return []; }
  const out: Settlement[] = [];
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const receipt = JSON.parse(await readFile(join(runs, name), "utf8")) as { attempt_id?: string; effects?: string; requested?: { profile?: string } };
    if (receipt.effects !== "unknown" || !receipt.attempt_id) continue;
    const r = await command("python3", ["-B", "-m", "agent_control.executor", "reconcile", "--state", state, "--database", config.controllerDatabase!,
      "--request", join(directory, "request.json"), "--attempt-id", receipt.attempt_id, "--actor", who, "--reason", reason], await realpath(config.controlRoot), undefined, 60_000);
    let parsed: { state?: string; blockers?: string[] } = {};
    try { parsed = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}"); } catch { /* reported as failed */ }
    out.push({ attemptId: receipt.attempt_id, profile: receipt.requested?.profile ?? "unknown",
      state: parsed.state === "reconciled" || parsed.state === "already-reconciled" || parsed.state === "refused" ? parsed.state : "failed",
      ...(parsed.blockers ? { blockers: parsed.blockers } : {}) });
  }
  return out;
}

export async function runController(config: Config, directory: string, runId: string, prompt: string, options: {
  profiles: readonly Profile[]; timeoutSeconds: number; onAttempt?: (attempt: ControllerAttempt) => void;
  /** Optional images for visual review (PNG/JPEG bytes); copied privately and pinned by SHA-256 in the request. */
  images?: { mediaType: "image/png" | "image/jpeg"; data: Buffer }[];
}): Promise<ControllerResult> {
  if (!controllerConfigured(config)) throw new DomainError("CONTROLLER_NOT_CONFIGURED", "Configure the native flow entrypoint and the reviewed admission ledger", 503);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) throw new DomainError("INVALID_RUN_ID", "Run identity does not match the executor contract", 422);
  if (Buffer.byteLength(prompt) > 120_000) throw new DomainError("PROMPT_TOO_LARGE", "Context exceeds the executor prompt bound", 422);
  const bound = controllerTransport(config) === "agentcore" ? 60 : await attemptBound(config);
  if (!(options.timeoutSeconds >= 1 && options.timeoutSeconds <= bound)) throw new DomainError("INVALID_TIMEOUT", `Executor attempts are limited to ${bound} s`, 422);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (controllerTransport(config) === "agentcore") return runRemote(config, directory, runId, prompt, options);
  const state = join(directory, "native-state");
  await writePrivate(join(directory, "prompt.txt"), prompt);
  const images = options.images ?? [];
  if (images.length > 3 || images.some(i => i.data.length > 1_500_000)) throw new DomainError("IMAGES_TOO_LARGE", "At most 3 images of up to 1.5 MB each", 422);
  const attached = [];
  for (const [i, image] of images.entries()) {
    const path = join(directory, `attach-${i}.${image.mediaType === "image/png" ? "png" : "jpg"}`);
    await writePrivate(path, image.data);
    attached.push({ path, media_type: image.mediaType, sha256: sha256(image.data) });
  }
  await writePrivate(join(directory, "request.json"), JSON.stringify({
    schema_version: 1, kind: "text-proposal", run_id: runId, prompt_file: join(directory, "prompt.txt"),
    profiles: options.profiles, timeout_seconds: options.timeoutSeconds, max_attempts: options.profiles.length, cost_bounds_microusd: null,
    ...(attached.length ? { images: attached } : {}),
  }, null, 2));
  // Poll the executor's receipts only to present progress; nothing here influences routing.
  const seen = new Set<string>();
  const poll = setInterval(() => void readAttempts(state, runId).then(list => {
    for (const a of list) { const key = `${a.profile}:${a.status}`; if (!seen.has(key)) { seen.add(key); options.onAttempt?.(a); } }
  }).catch(() => undefined), 1_000);
  let r: Awaited<ReturnType<typeof command>>;
  try {
    // The executor only runs when argv[1] equals its own module path, so symlinked install paths must be resolved.
    const [entry, root] = await Promise.all([realpath(config.controllerEntrypoint!), realpath(config.controlRoot)]);
    r = await command("node", [entry, "--state", state, "--database", config.controllerDatabase!,
      "--request", join(directory, "request.json")], root, undefined, Math.max(470_000, options.profiles.length * (options.timeoutSeconds + 15) * 1000 + 240_000),
      undefined, engineEnv(config));
    // An empty report with exit 0 means the flow never ran; never treat that as an answer.
    if (r.exitCode === 0 && !r.stdout.trim()) throw new DomainError("CONTROLLER_NO_REPORT", "Executor produced no report", 502);
  } finally { clearInterval(poll); }
  await writePrivate(join(directory, "stdout.json"), r.stdout);
  await writePrivate(join(directory, "stderr.log"), r.stderr.slice(0, 20_000));
  const attempts = await readAttempts(state, runId);
  for (const a of attempts) { const key = `${a.profile}:${a.status}`; if (!seen.has(key)) options.onAttempt?.(a); }
  return interpret(runId, r.stdout.trim().split("\n").at(-1) ?? "", r.exitCode, attempts, sha256(r.stdout));
}

/** Same request on the AgentCore agent runtime; its report goes through the same checks as a local run. */
async function runRemote(config: Config, directory: string, runId: string, prompt: string, options: {
  profiles: readonly Profile[]; timeoutSeconds: number; onAttempt?: (attempt: ControllerAttempt) => void;
  images?: { mediaType: "image/png" | "image/jpeg"; data: Buffer }[];
}): Promise<ControllerResult> {
  if (options.profiles.some(p => !enabledProfiles(config).includes(p))) throw new DomainError("AI_PROFILE_NOT_ENABLED", "AgentCore 执行器未启用该引擎", 422);
  await writePrivate(join(directory, "prompt.txt"), prompt);
  const Remote = z.object({ exitCode: z.number().nullable(), timedOut: z.boolean(), report: z.string(),
    attempts: z.array(z.object({ profile: z.string(), status: z.string().nullable(), errorKind: z.string().nullable(), model: z.string().nullable(),
      engineVersion: z.string().nullable(), effects: z.string().nullable(), workStarted: z.boolean().nullable().optional() }).passthrough()) }).passthrough();
  const images = (options.images ?? []).map(i => ({ media_type: i.mediaType, sha256: sha256(i.data), data: i.data.toString("base64") }));
  if (images.length > 3 || (options.images ?? []).some(i => i.data.length > 1_500_000)) throw new DomainError("IMAGES_TOO_LARGE", "At most 3 images of up to 1.5 MB each", 422);
  const raw = await invokeRuntime<unknown>(config.agentcoreAgentArn!, { op: "text-proposal", run_id: runId, prompt, profiles: options.profiles,
    timeout_seconds: options.timeoutSeconds, ...(images.length ? { images } : {}) }, { timeoutMs: 600_000 });
  const error = z.object({ error: z.string(), message: z.string().optional() }).safeParse(raw);
  if (error.success) throw new DomainError(error.data.error, `AgentCore 执行器拒绝：${error.data.message ?? error.data.error}`, 502);
  const r = Remote.parse(raw);
  await writePrivate(join(directory, "agentcore.json"), JSON.stringify({ ...r, report: undefined, reportSha256: sha256(r.report) }, null, 2));
  const attempts: ControllerAttempt[] = r.attempts.map(a => ({ profile: a.profile, provider: PROVIDER[a.profile as Profile] ?? "unknown", status: a.status ?? "unknown",
    errorKind: a.errorKind, effects: a.effects ?? "unknown", model: a.model, engineVersion: a.engineVersion, modelEvidence: null, answered: a.status === "succeeded" }))
    .sort((a, b) => PROFILES.indexOf(a.profile as Profile) - PROFILES.indexOf(b.profile as Profile));
  for (const a of attempts) options.onAttempt?.(a);
  if (r.timedOut || r.exitCode === null) {
    return { runId, action: "reconcile", reason: "AgentCore executor did not finish within its bound; inspect remote receipts", flowStatus: "unknown", exitCode: -1, attempts, reportSha256: sha256(r.report) };
  }
  if (r.exitCode === 0 && !r.report.trim()) throw new DomainError("CONTROLLER_NO_REPORT", "Executor produced no report", 502);
  return interpret(runId, r.report, r.exitCode, attempts, sha256(r.report));
}

function interpret(runId: string, line: string, exitCode: number, attempts: ControllerAttempt[], reportSha256: string): ControllerResult {
  let parsed: z.infer<typeof Report>;
  try { parsed = Report.parse(JSON.parse(line)); }
  catch {
    return { runId, action: "reconcile", reason: "Executor output could not be parsed; inspect native receipts", flowStatus: "unknown", exitCode,
      attempts, reportSha256 };
  }
  if (parsed.report.run_id !== runId) throw new DomainError("CONTROLLER_MISMATCH", "Executor report belongs to another run", 422);
  const result = parsed.report.result;
  const profile = result?.requested?.profile;
  let action: ControllerAction = parsed.report.action;
  // A "done" report must be backed by a completed flow, a clean exit, an answer and verified absence of effects.
  if (action === "done" && (parsed.flow_status !== "completed" || exitCode !== 0 || !result?.answer || result.effects !== "none")) action = "reconcile";
  return {
    runId, action, reason: parsed.report.reason, flowStatus: parsed.flow_status, exitCode,
    answer: typeof result?.answer === "string" ? result.answer : undefined, effects: result?.effects, attempts,
    engine: profile ? { profile, provider: PROVIDER[profile as Profile] ?? "unknown", model: result?.observed?.model ?? null,
      engineVersion: result?.observed?.engine_version ?? null, modelEvidence: result?.observed?.model_evidence ?? null } : undefined,
    reportSha256,
  };
}
