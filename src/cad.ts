import { randomUUID } from "node:crypto";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command, NativeAdapters, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Feedback, type Project, type Receipt, type DiffResult } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { NativeEvent, type SceneStage } from "./scenes.js";
import { ISOLATION, sandboxArgs, sandboxRuntime, sandboxStatus, type SandboxRuntime } from "./sandbox.js";

/**
 * Parametric CAD review: a controlled CadQuery/OCCT recipe for a NEMA 17 motor-mount bracket.
 * Baseline (reference parameters) and candidate are produced natively, measured on the B-Rep,
 * mapped to JUnit and compared by EvalArc. Editable STEP plus STL/GLB/SVG are retained by digest.
 * Nominal geometry and DFM rules of thumb only — no FEA, tolerance stack-up or physical test.
 */
export const CAD_CHECKS = ["solid-valid", "nema17-interface", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope"] as const;
export const CAD_PRESETS = ["reference", "lightweight", "undersize-bore", "compact"] as const;
/** "generated": the candidate solid comes from CadQuery code (AI, external agent or maintainer) run in the OS sandbox. */
export const CAD_VARIANTS = [...CAD_PRESETS, "parametric", "generated"] as const;
/** Bounded explicit parameters of the trusted recipe (variant "parametric", e.g. a chosen sweep point); mirrors native/cad_recipe.py BOUNDS. */
export const CadParameters = z.object({
  thickness: z.number().min(2).max(8), width: z.number().min(46).max(80), plateHeight: z.number().min(40).max(60), pilotBore: z.number().min(21).max(24),
}).strict();
export type CadParameters = z.infer<typeof CadParameters>;
export const CadSource = z.object({ language: z.literal("cadquery-2.8"), code: z.string().min(40).max(20_000) }).strict();
export type CadSource = z.infer<typeof CadSource>;
export const CAD_FILES = ["part.step", "part.stl", "part.glb", "assembly.glb", "drawing.svg", "checks.json"] as const;
const mm = z.number().min(1).max(2000);
export const CadRequirements = z.object({
  maxMassG: z.number().min(1).max(10000), minWallMm: z.number().min(0.5).max(50),
  edgeDistanceFactor: z.number().min(1).max(4), requireNoInterference: z.boolean(), maxEnvelopeMm: z.tuple([mm, mm, mm]),
}).strict();
export type CadRequirements = z.infer<typeof CadRequirements>;
export const DEFAULT_CAD_REQUIREMENTS: CadRequirements = { maxMassG: 80, minWallMm: 3, edgeDistanceFactor: 1.5, requireNoInterference: true, maxEnvelopeMm: [80, 40, 60] };
export const CadRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(), variant: z.enum(CAD_VARIANTS),
  requirements: CadRequirements, feedbackId: Id.optional(), source: CadSource.optional(), parameters: CadParameters.optional(),
  /** Provenance only: the sweep and point a parametric candidate was chosen from. */
  fromSweep: z.object({ sweepId: Id, point: z.number().int().min(1).max(36) }).strict().optional(),
}).strict()
  .refine(r => (r.variant === "generated") === Boolean(r.source), { message: "variant generated requires source code, and only generated takes source", path: ["source"] })
  .refine(r => (r.variant === "parametric") === Boolean(r.parameters), { message: "variant parametric requires parameters, and only parametric takes them", path: ["parameters"] })
  .refine(r => !r.fromSweep || r.variant === "parametric", { message: "fromSweep only applies to parametric candidates", path: ["fromSweep"] });
export const CadChecks = z.object({
  schema: z.literal("pai-cad-checks-1"), variant: z.enum(CAD_VARIANTS), cadquery: z.string(), ocp: z.string(), units: z.literal("mm"),
  mass: z.number(), volume: z.number(), boundingBox: z.array(z.number()).length(3),
  checks: z.array(z.object({ id: z.enum(CAD_CHECKS), passed: z.boolean() }).passthrough()).length(7),
  scope: z.literal("parametric-part-geometry"), physicalValidation: z.literal(false),
}).passthrough();
export type CadChecks = z.infer<typeof CadChecks>;
export interface CadReview {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof CadRequest>;
  requirementDigest: string; state: "running" | "completed" | "failed" | "interrupted"; error?: string;
  createdAt: string; finishedAt?: string; feedbackId?: string; verdict?: "accepted-cad-part" | "rejected";
  baseline?: CadChecks; candidate?: CadChecks; diff?: DiffResult;
  receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  stages?: Partial<Record<"baseline" | "candidate", SceneStage[]>>;
  /** Generated candidate: code digest, isolation layers and the sandbox outcome. */
  sandbox?: { codeSha256: string; isolation: readonly string[]; status: "ok" | "policy" | "error" | "limit"; violations?: string[]; error?: string; motorAxisZ?: number };
  scope: "parametric-part-geometry"; physicalValidation: false;
}

function checksXml(value: CadChecks) {
  if (new Set(value.checks.map(c => c.id)).size !== CAD_CHECKS.length) throw new DomainError("CAD_CHECK_COVERAGE", "Native CAD check IDs must be unique and complete");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="bracket.cad" tests="${CAD_CHECKS.length}">`
    + [...value.checks].sort((a, b) => a.id < b.id ? -1 : 1).map(c =>
      `<testcase classname="bracket.cad" name="${c.id}">${c.passed ? "" : '<failure message="Native CAD geometry check failed"/>'}</testcase>`).join("")
    + "</testsuite>\n";
}
export function cadCaseText(run: CadReview) {
  return `# Parametric CAD part review — NEMA 17 motor-mount bracket\n\nDecision: ${run.verdict ?? "pending"}; variant: ${run.request.variant}.\n`
    + `Native CadQuery ${run.candidate?.cadquery ?? "unknown"} / OCCT ${run.candidate?.ocp ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
    + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
    + (run.sandbox ? `Generated CadQuery code SHA-256 ${run.sandbox.codeSha256}, executed in an OS sandbox (${run.sandbox.isolation.join(", ")}); outcome ${run.sandbox.status}.\n` : "")
    + `Mass ${run.candidate?.mass ?? "?"} g (6061 aluminium, nominal). Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: nominal parametric geometry with editable STEP and DFM rules of thumb. No FEA, tolerance stack-up, process simulation or physical test.\n";
}

/**
 * Run untrusted code in the sandbox. Only an exact BREP solid and a small result file leave it; the solid is then
 * measured by a second sandboxed process with the shared checks. Outcomes other than "ok" fail the review with a reason.
 */
async function buildGenerated(config: Config, publish: LiveBus["publish"], record: CadReview, directory: string, runtime: SandboxRuntime,
  source: CadSource, codeSha256: string, requestId: string) {
  const code = join(directory, "candidate-code.py"), out = join(directory, "candidate-src");
  await writePrivate(code, source.code);
  await mkdir(out, { recursive: true, mode: 0o700 });
  record.sandbox = { codeSha256, isolation: ISOLATION, status: "error" };
  publish(requestId, { kind: "step", id: "cad-sandbox", label: "在隔离沙箱中运行生成代码", status: "running", which: "candidate" });
  const argv = [runtime.python, "-I", "-W", "ignore", join(runtime.native, "cad_sandbox.py"), "--code", code, "--output", out, "--cpu-seconds", "60"];
  let exitCode: number | null = null, stdout = "", startedAt = new Date().toISOString(), finishedAt = startedAt;
  try {
    const r = await command(config.bwrap ?? "bwrap", sandboxArgs(config, runtime, { readOnly: [code], writable: [out] }, argv), config.repository, undefined, 120_000);
    ({ exitCode, stdout, startedAt, finishedAt } = r);
    await writePrivate(join(directory, "sandbox.stderr.log"), r.stderr);
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "NATIVE_INTERRUPTED")) throw error;
    finishedAt = new Date().toISOString();
  }
  record.receipts.push({ adapter: "cadquery-sandbox", command: ["bwrap", ...ISOLATION.map(x => `[${x}]`), "python", "cad_sandbox.py"], startedAt, finishedAt,
    exitCode: exitCode ?? -1, stdoutSha256: sha256(stdout), sourceDigests: { code: codeSha256 } });
  const Outcome = z.object({ status: z.enum(["ok", "policy", "error", "limit"]), violations: z.array(z.string()).optional(), type: z.string().optional(),
    message: z.string().optional(), motorAxisZ: z.number().optional() });
  const outcome = await readFile(join(out, "result.json"), "utf8").then(t => Outcome.parse(JSON.parse(t))).catch(() => undefined);
  // No result file means the process was stopped (CPU/wall limit, memory) before it could report.
  const status = exitCode === 0 && outcome?.status === "ok" ? "ok" : outcome?.status && outcome.status !== "ok" ? outcome.status : "limit";
  record.sandbox = { ...record.sandbox, status, violations: outcome?.violations, motorAxisZ: outcome?.motorAxisZ,
    error: status === "ok" ? undefined : status === "limit" ? outcome?.message ?? "超出沙箱资源或时间上限（CPU 60 s、内存 3 GiB、墙钟 120 s）"
      : status === "policy" ? outcome?.violations?.join("；") : `${outcome?.type ?? "Error"}: ${outcome?.message ?? ""}`.slice(0, 600) };
  publish(requestId, { kind: "step", id: "cad-sandbox", label: "在隔离沙箱中运行生成代码", status: status === "ok" ? "done" : "failed", which: "candidate",
    detail: status === "ok" ? `BREP 实体 · 电机轴 z=${outcome?.motorAxisZ} mm` : record.sandbox.error?.slice(0, 160) });
  if (status !== "ok") {
    const code = { policy: "CAD_CODE_POLICY", error: "CAD_CODE_ERROR", limit: "CAD_CODE_LIMIT" }[status];
    throw new DomainError(code, `生成代码没有产生可检查的实体：${record.sandbox.error}`, 422);
  }
  record.files["candidate/generated.brep"] = sha256(await readFile(join(out, "generated.brep")));
}

/**
 * Generated code is refused before any record exists: no sandbox means no execution, and a policy violation never
 * reaches the sandbox. Call before reviewCad (which must claim its request before its first await).
 */
export async function precheckCad(store: Store, config: Config, input: unknown) {
  const request = CadRequest.parse(input);
  if (request.variant !== "generated" || store.requestRun(request.requestId) || !config.cadquery) return;
  const status = await sandboxStatus(config);
  if (!status.available) throw new DomainError("CAD_SANDBOX_UNAVAILABLE", `生成代码需要 OS 沙箱：${status.reason}`, 503);
  const violations = await checkCadCode(config, request.source!.code);
  if (violations.length) throw new DomainError("CAD_CODE_POLICY", `代码不符合沙箱策略：${violations.slice(0, 5).join("；")}`, 422);
}

export async function reviewCad(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<CadReview> {
  const request = CadRequest.parse(input);
  const publish: LiveBus["publish"] = (key, event) => live?.publish(key, event);
  if (!config.cadquery) throw new DomainError("CAD_NOT_CONFIGURED", "Set PAI_CADQUERY_PYTHON to a pinned CadQuery interpreter (npm run setup:cad)", 503);
  const generated = request.variant === "generated" ? request.source! : undefined;
  if (request.fromSweep && !store.requestRun(request.requestId)) {
    // Provenance must be true: the sweep is this project's, completed, and measured exactly these parameters.
    const sweep = store.get<{ projectId: string; state: string; result?: { points: { index: number; parameters: unknown }[] } }>("cad-sweep", request.fromSweep.sweepId);
    const point = sweep?.result?.points.find(p => p.index === request.fromSweep!.point);
    if (!sweep || sweep.projectId !== project.id || sweep.state !== "completed" || !point || canonical(point.parameters) !== canonical(request.parameters)) {
      throw new DomainError("INVALID_SWEEP_POINT", "fromSweep must reference a measured point of a completed sweep of this project with identical parameters", 422);
    }
  }
  const record: CadReview = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision, request,
    requirementDigest: sha256(canonical({ projectRequirements: project.requirements, cadRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), feedbackId: request.feedbackId,
    receipts: [], sourceDigests: {}, files: {}, scope: "parametric-part-geometry", physicalValidation: false };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "cad-part", projectId: project.id, request })), record, "cad-review");
  if (claimed !== record.id) return store.get<CadReview>("cad-review", claimed)!;
  publish(request.requestId, { kind: "record", recordKind: "cad-review", recordId: record.id });
  const directory = join(config.state, "cad", record.id);
  try {
    if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
    if (request.feedbackId) {
      const f = store.get<Feedback>("feedback", request.feedbackId);
      const original = f ? store.get<CadReview>("cad-review", f.runId) : undefined;
      if (!f || f.evidenceKind !== "cad-part" || f.projectId !== project.id || !["fix-proposed", "no-change-with-reason"].includes(f.status)
          || canonical(original?.request.requirements) !== canonical(request.requirements)) {
        throw new DomainError("INVALID_RECHECK", "CAD recheck must bind the same feedback and unchanged part requirements");
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const native = (file: string) => join(config.repository, "native", file);
    const script = native("cad_bracket.py"), lock = native("cadquery-requirements.txt");
    const used = ["cad_bracket.py", "cad_recipe.py", "cad_checks.py", ...(generated ? ["cad_code_policy.py", "cad_sandbox.py", "cad_generated.py"] : [])];
    const scriptDigests = async () => Object.fromEntries(await Promise.all(used.map(async f => [f.replace(/_/g, "-"), sha256(await readFile(native(f)))])));
    const adapters = new NativeAdapters(config);
    const scriptHash = sha256(await readFile(script));
    const scriptsBefore = await scriptDigests();
    const nativeBefore = await adapters.sourceDigests();
    const codeSha256 = generated ? sha256(generated.code) : undefined;
    record.sourceDigests = { ...nativeBefore, ...scriptsBefore, "cadquery-lock": sha256(await readFile(lock)), "cadquery-python": sha256(await readFile(config.cadquery)),
      ...(codeSha256 ? { "generated-code": codeSha256 } : {}) };
    const runtime = generated ? await sandboxRuntime(config) : undefined;
    const bwrap = config.bwrap ?? "bwrap";
    for (const [name, variant] of [["baseline", "reference"], ["candidate", request.variant]] as const) {
      const target = join(directory, name);
      const label = `CadQuery ${name === "baseline" ? "基准零件" : "候选零件"}（${variant}）`;
      publish(request.requestId, { kind: "step", id: `cad-${name}`, label, status: "running", which: name });
      const input = join(directory, `${name}-input.json`);
      await writePrivate(input, JSON.stringify({ variant, requirements: request.requirements, ...(codeSha256 ? { codeSha256 } : {}),
        ...(variant === "parametric" ? { parameters: request.parameters } : {}) }));
      await mkdir(target, { recursive: true, mode: 0o700 });
      const sandboxed = Boolean(generated && name === "candidate");
      if (sandboxed) await buildGenerated(config, publish, record, directory, runtime!, generated!, codeSha256!, request.requestId);
      let observed = Promise.resolve();
      const observe = (line: string) => {
        if (!line.startsWith("PAI_EVENT ")) return;
        observed = observed.then(async () => {
          const parsed = NativeEvent.safeParse((() => { try { return JSON.parse(line.slice(10)); } catch { return undefined; } })());
          if (!parsed.success || parsed.data.type !== "stage") return;
          const e = parsed.data;
          const digest = sha256(await readFile(join(target, e.file)));
          const stage: SceneStage = { index: e.index, id: e.id, label: e.label, file: e.file, sha256: digest, objects: e.objects };
          record.stages = { ...record.stages, [name]: [...(record.stages?.[name] ?? []), stage] };
          store.put("cad-review", record);
          publish(request.requestId, { kind: "stage", which: name, index: e.index, id: e.id, label: e.label, objects: e.objects,
            url: `/api/cad/${record.id}/stages/${name}/${e.index}`, sha256: digest });
        }).catch(() => { /* Presentation events never fail the native review. */ });
      };
      const args = sandboxed
        ? sandboxArgs(config, runtime!, { readOnly: [input, join(directory, "candidate-src")], writable: [target] },
          [runtime!.python, "-I", "-W", "ignore", join(runtime!.native, "cad_generated.py"), "--input", input, "--source", join(directory, "candidate-src"), "--output", target])
        : ["-I", "-W", "ignore", script, "--input", input, "--output", target];
      const r = await command(sandboxed ? bwrap : config.cadquery, args, config.repository, undefined, 180_000, observe);
      await observed;
      await writePrivate(join(directory, `${name}.stdout.log`), r.stdout);
      await writePrivate(join(directory, `${name}.stderr.log`), r.stderr);
      record.receipts.push({ adapter: sandboxed ? "cadquery-sandbox-check" : "cadquery-native", command: sandboxed ? ["bwrap", "…", "python", "cad_generated.py"] : ["python", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt,
        exitCode: r.exitCode, stdoutSha256: sha256(r.stdout),
        sourceDigests: sandboxed ? { script: scriptsBefore["cad-generated.py"], checks: scriptsBefore["cad-checks.py"] } : { script: scriptHash, checks: scriptsBefore["cad-checks.py"] } });
      publish(request.requestId, { kind: "step", id: `cad-${name}`, label, status: r.exitCode === 0 ? "done" : "failed", which: name, detail: `exit ${r.exitCode}` });
      store.put("cad-review", record);
      if (r.exitCode !== 0) throw new DomainError("CAD_FAILED", "Native CAD production failed; retain receipts and inspect local artifacts", 422);
      const checks = CadChecks.parse(JSON.parse(await readFile(join(target, "checks.json"), "utf8")));
      if (checks.variant !== variant) throw new DomainError("CAD_CONTEXT", "Native CAD variant mismatch");
      record[name] = checks;
      await writeFile(join(directory, name === "baseline" ? "baseline.xml" : "current.xml"), checksXml(checks), { mode: 0o600, flag: "wx" });
      for (const file of CAD_FILES) record.files[`${name}/${file}`] = sha256(await readFile(join(target, file)));
      store.put("cad-review", record);
    }
    publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选零件", status: "running" });
    const diff = await adapters.diff(directory);
    publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选零件", status: "done", detail: `blocking ${diff.value.blocking_changes}` });
    const lost = record.baseline!.checks.filter(c => c.passed && !record.candidate!.checks.find(n => n.id === c.id)!.passed).length;
    if (diff.value.blocking_changes !== lost || diff.value.gate_passed !== (lost === 0)) throw new DomainError("CAD_DIFF_MISMATCH", "Native CAD checks and independent comparison disagree");
    if (sha256(await readFile(script)) !== scriptHash || canonical(scriptsBefore) !== canonical(await scriptDigests())
        || canonical(nativeBefore) !== canonical(await adapters.sourceDigests())) {
      throw new DomainError("SOURCE_CHANGED", "Native verifier changed during CAD production");
    }
    record.diff = diff.value; record.receipts.push(diff.receipt);
    record.verdict = record.candidate!.checks.every(c => c.passed) && record.baseline!.checks.every(c => c.passed) ? "accepted-cad-part" : "rejected";
    record.state = "completed";
  } catch (e) { record.state = "failed"; record.error = e instanceof DomainError ? `${e.code}: ${e.message}` : "CAD_FAILED: check native configuration and retained local receipts"; }
  record.finishedAt = new Date().toISOString(); store.put("cad-review", record);
  publish(request.requestId, { kind: "done", state: record.state, recordId: record.id, verdict: record.verdict, detail: record.error });
  return record;
}

/** Layer 1 (static policy) as a fast pre-check; never executes the code. Returns the violations. */
export async function checkCadCode(config: Config, code: string): Promise<string[]> {
  const directory = join(config.state, "cad-policy");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${randomUUID()}.py`);
  await writePrivate(file, code);
  try {
    const r = await command(config.cadquery ?? "python3", ["-I", join(config.repository, "native/cad_code_policy.py"), file], config.repository, undefined, 15_000);
    const out = z.object({ ok: z.boolean(), violations: z.array(z.string()) }).parse(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}"));
    return out.violations;
  } finally { await rm(file, { force: true }); }
}
export const CAD_TEMPLATE_FILE = "native/cad_template.py";
