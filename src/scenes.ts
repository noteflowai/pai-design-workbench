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

export interface SceneStage { index: number; id: string; label: string; file: string; sha256: string; objects: string[] }
export interface SceneRay { origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean; frame: "gltf-y-up" }
const NativeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), index: z.number().int().min(1).max(16), id: z.string().regex(/^[a-z-]{1,24}$/),
    label: z.string().max(80), file: z.string().regex(/^stages\/\d{2}-[a-z-]{1,24}\.glb$/), objects: z.array(z.string().max(80)).max(32) }).strict(),
  z.object({ type: z.literal("ray"), origin: z.array(z.number()).length(3), target: z.array(z.number()).length(3),
    hit: z.array(z.number()).length(3).nullable(), firstHit: z.string().max(80).nullable(), visible: z.boolean() }).strict(),
  z.object({ type: z.literal("render"), sample: z.number().int().min(0), samples: z.number().int().positive() }).strict(),
]);

export const SceneRequirements = z.object({
  maxFootprintArea: z.number().min(1).max(100),
  targetEnvelopeRadius: z.number().min(0.1).max(10),
  requireTargetVisible: z.boolean(),
}).strict();
export const SceneRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(),
  variant: z.enum(["clear", "occluded"]), requirements: SceneRequirements, feedbackId: Id.optional(),
}).strict();
export const SceneChecks = z.object({
  schema: z.literal("pai-blender-checks-1"), blenderVersion: z.string(), variant: z.enum(["clear", "occluded"]),
  checks: z.array(z.object({ id: z.enum(["footprint-area", "declared-target-envelope", "camera-visibility"]),
    passed: z.boolean() }).passthrough()).length(3),
  scope: z.literal("generated-static-geometry"), physicalValidation: z.literal(false),
}).passthrough();
export interface SceneReview {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof SceneRequest>;
  requirementDigest: string; state: "running" | "completed" | "failed" | "interrupted"; error?: string;
  createdAt: string; finishedAt?: string; feedbackId?: string; verdict?: "accepted-static-scene" | "rejected";
  baseline?: z.infer<typeof SceneChecks>; candidate?: z.infer<typeof SceneChecks>; diff?: DiffResult;
  receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  stages?: Partial<Record<"baseline" | "candidate", SceneStage[]>>; rays?: Partial<Record<"baseline" | "candidate", SceneRay>>;
  scope: "generated-static-geometry"; physicalValidation: false;
}
export function sceneCaseText(run: SceneReview) {
  return `# Blender workcell design review\n\nDecision: ${run.verdict ?? "pending"}; variant: ${run.request.variant}.\n`
    + `Native Blender: ${run.candidate?.blenderVersion ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
    + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
    + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: generated static geometry from an explicit synthetic recipe; editable .blend and GLB artifacts. No dynamics, joint reachability, measured factory twin, manufacturability or physical validation.\n";
}
function checksXml(value: z.infer<typeof SceneChecks>) {
  if (new Set(value.checks.map(c => c.id)).size !== 3) throw new DomainError("SCENE_CHECK_COVERAGE", "Native check IDs must be unique");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="workcell.static" tests="3">`
    + [...value.checks].sort((a, b) => a.id < b.id ? -1 : 1).map(c =>
      `<testcase classname="workcell.static" name="${c.id}">${c.passed ? "" : '<failure message="Native static geometry check failed"/>'}</testcase>`).join("")
    + "</testsuite>\n";
}
export async function reviewScene(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<SceneReview> {
  const request = SceneRequest.parse(input);
  const publish: LiveBus["publish"] = (key, event) => live?.publish(key, event);
  if (!config.blender) throw new DomainError("BLENDER_NOT_CONFIGURED", "Set PAI_BLENDER to a native Blender executable", 503);
  const record: SceneReview = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision,
    request, requirementDigest: sha256(canonical({ projectRequirements: project.requirements, sceneRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), feedbackId: request.feedbackId,
    receipts: [], sourceDigests: {}, files: {}, scope: "generated-static-geometry", physicalValidation: false };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "blender-scene", projectId: project.id, request })), record, "scene-review");
  if (claimed !== record.id) return store.get<SceneReview>("scene-review", claimed)!;
  publish(request.requestId, { kind: "record", recordKind: "scene-review", recordId: record.id });
  const directory = join(config.state, "scenes", record.id);
  try {
    if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
    if (request.feedbackId) {
      const f = store.get<Feedback>("feedback", request.feedbackId);
      const original = f ? store.get<SceneReview>("scene-review", f.runId) : undefined;
      if (!f || f.evidenceKind !== "blender-scene" || f.projectId !== project.id
          || !["fix-proposed", "no-change-with-reason"].includes(f.status)
          || canonical(original?.request.requirements) !== canonical(request.requirements)) {
        throw new DomainError("INVALID_RECHECK", "Scene recheck must bind the same feedback and unchanged static constraints");
      }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = join(config.repository, "native/blender_workcell.py");
    const adapters = new NativeAdapters(config);
    const scriptHash = sha256(await readFile(script));
    const nativeBefore = await adapters.sourceDigests();
    record.sourceDigests = { ...nativeBefore, "blender-workcell.py": scriptHash, "blender-binary": sha256(await readFile(config.blender)) };
    for (const [name, variant] of [["baseline", "clear"], ["candidate", request.variant]] as const) {
      const target = join(directory, name);
      const label = `Blender ${name === "baseline" ? "基准" : "候选"}场景（${variant === "occluded" ? "遮挡" : "无遮挡"}）`;
      publish(request.requestId, { kind: "step", id: `blender-${name}`, label, status: "running", which: name });
      let observed = Promise.resolve();
      const observe = (line: string) => {
        if (!line.startsWith("PAI_EVENT ")) return;
        observed = observed.then(async () => {
          const parsed = NativeEvent.safeParse((() => { try { return JSON.parse(line.slice(10)); } catch { return undefined; } })());
          if (!parsed.success) return;
          const e = parsed.data;
          if (e.type === "stage") {
            const digest = sha256(await readFile(join(target, e.file)));
            const stage: SceneStage = { index: e.index, id: e.id, label: e.label, file: e.file, sha256: digest, objects: e.objects };
            record.stages = { ...record.stages, [name]: [...(record.stages?.[name] ?? []), stage] };
            store.put("scene-review", record);
            publish(request.requestId, { kind: "stage", which: name, index: e.index, id: e.id, label: e.label, objects: e.objects,
              url: `/api/scenes/${record.id}/stages/${name}/${e.index}`, sha256: digest });
          } else if (e.type === "ray") {
            const { type: _type, ...ray } = e;
            record.rays = { ...record.rays, [name]: { ...ray, frame: "gltf-y-up" } };
            store.put("scene-review", record);
            publish(request.requestId, { kind: "ray", which: name, origin: e.origin, target: e.target, hit: e.hit, firstHit: e.firstHit, visible: e.visible });
          } else {
            publish(request.requestId, { kind: "render", which: name, sample: e.sample, samples: e.samples });
          }
        }).catch(() => { /* Presentation events never fail the native review. */ });
      };
      await writePrivate(join(directory, `${name}-input.json`), JSON.stringify({ variant, requirements: request.requirements }));
      const args = ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", script,
        "--", "--input", join(directory, `${name}-input.json`), "--output", target];
      const r = await command(config.blender, args, config.repository, undefined, 120_000, observe);
      await observed;
      await writePrivate(join(directory, `${name}.stdout.log`), r.stdout);
      await writePrivate(join(directory, `${name}.stderr.log`), r.stderr);
      record.receipts.push({ adapter: "blender-native", command: ["blender", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt,
        exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: { "script": scriptHash } });
      store.put("scene-review", record);
      publish(request.requestId, { kind: "step", id: `blender-${name}`, label, status: r.exitCode === 0 ? "done" : "failed", which: name,
        detail: `exit ${r.exitCode}` });
      if (r.exitCode !== 0) throw new DomainError("BLENDER_FAILED", "Native scene production failed; retain receipts and inspect local artifacts", 422);
      record[name] = SceneChecks.parse(JSON.parse(await readFile(join(target, "checks.json"), "utf8")));
      if (record[name]!.variant !== variant) throw new DomainError("SCENE_CONTEXT", "Native scene variant mismatch");
      await writeFile(join(directory, name === "baseline" ? "baseline.xml" : "current.xml"), checksXml(record[name]!), { mode: 0o600, flag: "wx" });
      for (const file of ["scene.blend", "scene.glb", "preview.png", "checks.json"]) {
        record.files[`${name}/${file}`] = sha256(await readFile(join(target, file)));
      }
      store.put("scene-review", record);
    }
    publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选", status: "running" });
    const diff = await adapters.diff(directory);
    publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选", status: "done", detail: `blocking ${diff.value.blocking_changes}` });
    const lost = record.baseline!.checks.filter(c => c.passed && !record.candidate!.checks.find(n => n.id === c.id)!.passed).length;
    if (diff.value.blocking_changes !== lost || diff.value.gate_passed !== (lost === 0)) throw new DomainError("SCENE_DIFF_MISMATCH", "Native geometry and independent comparison disagree");
    if (sha256(await readFile(script)) !== scriptHash || canonical(nativeBefore) !== canonical(await adapters.sourceDigests())
        || record.sourceDigests["blender-binary"] !== sha256(await readFile(config.blender))) throw new DomainError("SOURCE_CHANGED", "Native verifier changed during scene production");
    record.diff = diff.value; record.receipts.push(diff.receipt);
    record.verdict = record.candidate!.checks.every(c => c.passed) ? "accepted-static-scene" : "rejected";
    record.state = "completed";
  } catch (e) { record.state = "failed"; record.error = e instanceof DomainError ? `${e.code}: ${e.message}` : "BLENDER_FAILED: check native configuration and retained local receipts"; }
  record.finishedAt = new Date().toISOString(); store.put("scene-review", record);
  publish(request.requestId, { kind: "done", state: record.state, recordId: record.id, verdict: record.verdict, detail: record.error });
  return record;
}
