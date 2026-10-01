import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command, NativeAdapters, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Feedback, type Project, type Receipt, type DiffResult } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { NativeEvent, type SceneStage } from "./scenes.js";

/**
 * Parametric CAD review: a controlled CadQuery/OCCT recipe for a NEMA 17 motor-mount bracket.
 * Baseline (reference parameters) and candidate are produced natively, measured on the B-Rep,
 * mapped to JUnit and compared by EvalArc. Editable STEP plus STL/GLB/SVG are retained by digest.
 * Nominal geometry and DFM rules of thumb only — no FEA, tolerance stack-up or physical test.
 */
export const CAD_CHECKS = ["solid-valid", "nema17-interface", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope"] as const;
export const CAD_VARIANTS = ["reference", "lightweight", "undersize-bore", "compact"] as const;
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
  requirements: CadRequirements, feedbackId: Id.optional(),
}).strict();
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
    + `Mass ${run.candidate?.mass ?? "?"} g (6061 aluminium, nominal). Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: nominal parametric geometry with editable STEP and DFM rules of thumb. No FEA, tolerance stack-up, process simulation or physical test.\n";
}

export async function reviewCad(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<CadReview> {
  const request = CadRequest.parse(input);
  const publish: LiveBus["publish"] = (key, event) => live?.publish(key, event);
  if (!config.cadquery) throw new DomainError("CAD_NOT_CONFIGURED", "Set PAI_CADQUERY_PYTHON to a pinned CadQuery interpreter (npm run setup:cad)", 503);
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
    const script = join(config.repository, "native/cad_bracket.py"), lock = join(config.repository, "native/cadquery-requirements.txt");
    const adapters = new NativeAdapters(config);
    const scriptHash = sha256(await readFile(script));
    const nativeBefore = await adapters.sourceDigests();
    record.sourceDigests = { ...nativeBefore, "cad-bracket.py": scriptHash, "cadquery-lock": sha256(await readFile(lock)), "cadquery-python": sha256(await readFile(config.cadquery)) };
    for (const [name, variant] of [["baseline", "reference"], ["candidate", request.variant]] as const) {
      const target = join(directory, name);
      const label = `CadQuery ${name === "baseline" ? "基准零件" : "候选零件"}（${variant}）`;
      publish(request.requestId, { kind: "step", id: `cad-${name}`, label, status: "running", which: name });
      await writePrivate(join(directory, `${name}-input.json`), JSON.stringify({ variant, requirements: request.requirements }));
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
      const args = ["-I", "-W", "ignore", script, "--input", join(directory, `${name}-input.json`), "--output", target];
      const r = await command(config.cadquery, args, config.repository, undefined, 180_000, observe);
      await observed;
      await writePrivate(join(directory, `${name}.stdout.log`), r.stdout);
      await writePrivate(join(directory, `${name}.stderr.log`), r.stderr);
      record.receipts.push({ adapter: "cadquery-native", command: ["python", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt,
        exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: { script: scriptHash } });
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
    if (sha256(await readFile(script)) !== scriptHash || canonical(nativeBefore) !== canonical(await adapters.sourceDigests())) {
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
