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
export const NativeEvent = z.discriminatedUnion("type", [
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
/** Factory production-line layout: a bounded parameter set for the native plant recipe (no user code). */
export const PlantLayout = z.object({
  stations: z.number().int().min(3).max(8), stationPitch: z.number().min(3.5).max(7),
  aisleWidth: z.number().min(1.2).max(4.5), guardSize: z.number().min(2.6).max(5),
  rackRows: z.number().int().min(1).max(4), cameraHeight: z.number().min(2.4).max(6.5), agvs: z.number().int().min(0).max(4),
}).strict();
export const PlantRequirements = z.object({
  maxFootprintArea: z.number().min(50).max(5000), minAisleWidth: z.number().min(0.8).max(5),
  minGuardClearance: z.number().min(0).max(2), requireCameraCoverage: z.boolean(), maxEgressTravel: z.number().min(5).max(100),
}).strict();
/** Reference line used as the baseline of every plant review; it is measured natively like any candidate. */
export const PLANT_REFERENCE: z.infer<typeof PlantLayout> = { stations: 4, stationPitch: 5, aisleWidth: 3.2, guardSize: 4.0, rackRows: 2, cameraHeight: 4.5, agvs: 2 };
export const DEFAULT_PLANT_REQUIREMENTS: z.infer<typeof PlantRequirements> = { maxFootprintArea: 650, minAisleWidth: 2.4, minGuardClearance: 0.5, requireCameraCoverage: true, maxEgressTravel: 25 };
export const PLANT_CHECKS = ["footprint-area", "aisle-clearance", "guard-clearance", "camera-coverage", "egress-travel"] as const;
const Common = { requestId: Id, projectRevision: z.number().int().positive(), feedbackId: Id.optional() };
export const SceneRequest = z.union([
  z.object({ ...Common, variant: z.enum(["clear", "occluded"]), requirements: SceneRequirements }).strict(),
  z.object({ ...Common, variant: z.literal("plant"), layout: PlantLayout, requirements: PlantRequirements }).strict(),
]);
export type SceneRequestValue = z.infer<typeof SceneRequest>;
export const SceneChecks = z.union([
  z.object({
    schema: z.literal("pai-blender-checks-1"), blenderVersion: z.string(), variant: z.enum(["clear", "occluded"]),
    checks: z.array(z.object({ id: z.enum(["footprint-area", "declared-target-envelope", "camera-visibility"]),
      passed: z.boolean() }).passthrough()).length(3),
    scope: z.literal("generated-static-geometry"), physicalValidation: z.literal(false),
  }).passthrough(),
  z.object({
    schema: z.literal("pai-blender-plant-checks-1"), blenderVersion: z.string(), variant: z.literal("plant"), layout: PlantLayout,
    checks: z.array(z.object({ id: z.enum(PLANT_CHECKS), passed: z.boolean() }).passthrough()).length(5),
    scope: z.literal("generated-static-geometry"), physicalValidation: z.literal(false),
  }).passthrough(),
]);
export interface SceneReview {
  id: string; projectId: string; projectRevision: number; request: SceneRequestValue;
  requirementDigest: string; state: "running" | "completed" | "failed" | "interrupted"; error?: string;
  createdAt: string; finishedAt?: string; feedbackId?: string; verdict?: "accepted-static-scene" | "rejected";
  baseline?: z.infer<typeof SceneChecks>; candidate?: z.infer<typeof SceneChecks>; diff?: DiffResult;
  receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  stages?: Partial<Record<"baseline" | "candidate", SceneStage[]>>; rays?: Partial<Record<"baseline" | "candidate", SceneRay>>;
  scope: "generated-static-geometry"; physicalValidation: false;
}
export type PlantLayoutValue = z.infer<typeof PlantLayout>;
export type PlantRequirementsValue = z.infer<typeof PlantRequirements>;
export type WorkcellScene = SceneReview & { request: Extract<SceneRequestValue, { variant: "clear" | "occluded" }> };
export type PlantScene = SceneReview & { request: Extract<SceneRequestValue, { variant: "plant" }> };
export const isPlant = (s: SceneReview): s is PlantScene => s.request.variant === "plant";
/** Derived hall size of the native plant recipe (metres); the same formula as native/blender_plant.py. */
export const plantHall = (l: PlantLayoutValue) => ({ x: l.stations * l.stationPitch + 12, y: 10.95 + l.aisleWidth + 1.35 * l.rackRows });
/** Identity of a scene candidate: recipe, its layout parameters and the static requirements. */
export const sceneKey = (r: SceneRequestValue) => `${r.variant}:${canonical(r.variant === "plant" ? r.layout : null)}:${canonical(r.requirements)}`;
export function sceneCaseText(run: SceneReview) {
  if (run.request.variant === "plant") {
    return `# Blender factory production-line layout review\n\nDecision: ${run.verdict ?? "pending"}; layout: ${canonical(run.request.layout)}.\n`
      + `Native Blender: ${run.candidate?.blenderVersion ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
      + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
      + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
      + "Scope: synthetic explicit factory recipe measured with native ray casts (aisle, guard, camera coverage, egress). Illustrative animation only; no dynamics, joint limits, throughput, lighting levels, safety certification or measured plant data.\n";
  }
  return `# Blender workcell design review\n\nDecision: ${run.verdict ?? "pending"}; variant: ${run.request.variant}.\n`
    + `Native Blender: ${run.candidate?.blenderVersion ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
    + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
    + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: generated static geometry from an explicit synthetic recipe; editable .blend and GLB artifacts. No dynamics, joint reachability, measured factory twin, manufacturability or physical validation.\n";
}
function checksXml(value: z.infer<typeof SceneChecks>) {
  const n = value.checks.length, suite = value.variant === "plant" ? "plant.layout" : "workcell.static";
  if (new Set(value.checks.map(c => c.id)).size !== n) throw new DomainError("SCENE_CHECK_COVERAGE", "Native check IDs must be unique");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${suite}" tests="${n}">`
    + [...value.checks].sort((a, b) => a.id < b.id ? -1 : 1).map(c =>
      `<testcase classname="${suite}" name="${c.id}">${c.passed ? "" : '<failure message="Native static geometry check failed"/>'}</testcase>`).join("")
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
    const plant = request.variant === "plant";
    const script = join(config.repository, plant ? "native/blender_plant.py" : "native/blender_workcell.py");
    const adapters = new NativeAdapters(config);
    const scriptHash = sha256(await readFile(script));
    const nativeBefore = await adapters.sourceDigests();
    record.sourceDigests = { ...nativeBefore, [plant ? "blender-plant.py" : "blender-workcell.py"]: scriptHash, "blender-binary": sha256(await readFile(config.blender)) };
    for (const [name, variant] of [["baseline", plant ? "plant" : "clear"], ["candidate", request.variant]] as const) {
      const target = join(directory, name);
      const label = plant ? `Blender ${name === "baseline" ? "参考产线" : "候选产线"}（${(name === "baseline" ? PLANT_REFERENCE : (request as { layout: z.infer<typeof PlantLayout> }).layout).stations} 工位）`
        : `Blender ${name === "baseline" ? "基准" : "候选"}场景（${variant === "occluded" ? "遮挡" : "无遮挡"}）`;
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
      await writePrivate(join(directory, `${name}-input.json`), JSON.stringify(plant
        ? { variant, layout: name === "baseline" ? PLANT_REFERENCE : (request as { layout: unknown }).layout, requirements: request.requirements, render: name === "baseline" ? "preview" : "hero" }
        : { variant, requirements: request.requirements }));
      const args = ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", script,
        "--", "--input", join(directory, `${name}-input.json`), "--output", target];
      const r = await command(config.blender, args, config.repository, undefined, plant ? 900_000 : 120_000, observe);
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
      const measured = record[name]!;
      if (plant && (measured.variant !== "plant" || canonical(measured.layout) !== canonical(name === "baseline" ? PLANT_REFERENCE : (request as { layout: unknown }).layout))) {
        throw new DomainError("SCENE_CONTEXT", "Native plant layout differs from the requested layout");
      }
      await writeFile(join(directory, name === "baseline" ? "baseline.xml" : "current.xml"), checksXml(record[name]!), { mode: 0o600, flag: "wx" });
      for (const file of ["scene.blend", "scene.glb", "preview.png", "checks.json", ...(plant ? ["inspection.png"] : [])]) {
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
