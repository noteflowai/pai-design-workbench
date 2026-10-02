import { lazy, Suspense, useEffect, useState } from "react";
import { api, requestIdFor } from "./api";
import { useApp, type Ctx } from "./context";
import { Card, CheckTable, Chip, Verdict, verdictOf, type MeasuredCheck } from "./ui";
import { viewportModel } from "./studio";
import type { PlantLayoutValue, PlantRequirementsValue, PlantScene, SceneReview } from "../src/scenes";

const Viewport = lazy(() => import("./viewport"));

export const PLANT_CHECK_LABELS: Record<string, string> = { "footprint-area": "厂房占地", "aisle-clearance": "AGV 通道净宽",
  "guard-clearance": "围栏安全间距", "camera-coverage": "检测相机覆盖", "egress-travel": "最远疏散距离" };
export const PLANT_REFERENCE_LAYOUT: PlantLayoutValue = { stations: 4, stationPitch: 5, aisleWidth: 3.2, guardSize: 4.0, rackRows: 2, cameraHeight: 4.5, agvs: 2 };
export const PLANT_DEFAULT_REQUIREMENTS: PlantRequirementsValue = { maxFootprintArea: 650, minAisleWidth: 2.4, minGuardClearance: 0.5, requireCameraCoverage: true, maxEgressTravel: 25 };
/** Same derived hall size as the native recipe; shown before execution so the trade-off is visible. */
export const hallOf = (l: PlantLayoutValue) => ({ x: l.stations * l.stationPitch + 12, y: 10.95 + l.aisleWidth + 1.35 * l.rackRows });
export const isPlantScene = (s?: SceneReview): s is PlantScene => s?.request.variant === "plant";
export const plantTitle = (s: PlantScene) => `${s.request.layout.stations} 工位产线 · 通道 ${s.request.layout.aisleWidth} m`;

export function runPlant(c: Ctx, layout: PlantLayoutValue, requirements: PlantRequirementsValue) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-plant-${p.id}-${p.revision}-${JSON.stringify(layout)}-${JSON.stringify(requirements)}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "blender-scene" });
    const s = await c.track(requestId, `Blender 工厂产线 · ${layout.stations} 工位`, "blender-scene",
      () => api<SceneReview>(`/projects/${p.id}/scenes`, { requestId, projectRevision: p.revision, variant: "plant", layout, requirements }));
    c.navigate("validate", { kind: "blender-scene", id: s.id });
    if (s.state !== "completed") throw new Error(s.error ?? s.state);
  }, "原生 Blender 工厂产线和独立检查已生成。");
}

const LAYOUT_FIELDS: { k: keyof PlantLayoutValue; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { k: "stations", label: "工位数", min: 3, max: 8, step: 1 }, { k: "stationPitch", label: "工位节距", min: 3.5, max: 7, step: 0.1, unit: "m" },
  { k: "aisleWidth", label: "AGV 通道设计宽度", min: 1.2, max: 4.5, step: 0.1, unit: "m" }, { k: "guardSize", label: "安全围栏边长", min: 2.6, max: 5, step: 0.1, unit: "m" },
  { k: "rackRows", label: "货架排数", min: 1, max: 4, step: 1 }, { k: "cameraHeight", label: "检测相机龙门高度", min: 2.4, max: 6.5, step: 0.1, unit: "m" },
  { k: "agvs", label: "AGV 台数", min: 0, max: 4, step: 1 },
];
const REQ_FIELDS: { k: Exclude<keyof PlantRequirementsValue, "requireCameraCoverage">; label: string; min: number; max: number; step: number; unit: string }[] = [
  { k: "maxFootprintArea", label: "厂房占地上限", min: 50, max: 5000, step: 1, unit: "m²" }, { k: "minAisleWidth", label: "通道净宽下限", min: 0.8, max: 5, step: 0.1, unit: "m" },
  { k: "minGuardClearance", label: "围栏安全间距下限", min: 0, max: 2, step: 0.05, unit: "m" }, { k: "maxEgressTravel", label: "疏散距离上限", min: 5, max: 100, step: 0.5, unit: "m" },
];

/** Design panel: bounded layout parameters, frozen layout requirements and the derived hall before running. */
export function PlantLane() {
  const c = useApp();
  const q = c.route.params;
  const last = c.data.scenes.filter((s): s is PlantScene => s.projectId === c.project!.id && isPlantScene(s)).at(-1);
  const fromQuery = <T extends object>(base: T): T => Object.fromEntries(Object.entries(base).map(([k, v]) =>
    [k, q.has(k) ? (typeof v === "boolean" ? q.get(k) === "true" : Number(q.get(k))) : v])) as T;
  const [layout, setLayout] = useState<PlantLayoutValue>(() => fromQuery(last?.request.layout ?? PLANT_REFERENCE_LAYOUT));
  const [req, setReq] = useState<PlantRequirementsValue>(() => fromQuery(last?.request.requirements ?? PLANT_DEFAULT_REQUIREMENTS));
  useEffect(() => { if (q.get("stations")) c.toast("计划参数已填入工厂产线面板，可调整后执行。"); }, []);
  const hall = hallOf(layout), area = hall.x * hall.y;
  return <Card title="工厂产线布局（Blender 原生生成 + 射线实测）" aside={<Chip tone="info">合成配方 · 非实测工厂</Chip>}>
    <p className="muted">CNC 加工中心、六轴机器人、安全围栏、输送线、货架、AGV、桥式起重机与检测相机龙门。Blender 按参数生成 .blend/GLB（含动画）并用 Cycles 渲染，
      用 BVH 射线实测通道净宽、围栏间距、相机覆盖与疏散距离。基准为 4 工位参考产线。</p>
    <fieldset className="field-grid"><legend>布局参数</legend>{LAYOUT_FIELDS.map(f =>
      <label key={f.k}>{f.label}<span className="unit-input"><input type="number" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={layout[f.k]}
        onChange={e => setLayout({ ...layout, [f.k]: Number(e.target.value) })} />{f.unit && <em>{f.unit}</em>}</span></label>)}</fieldset>
    <fieldset className="field-grid"><legend>布局要求</legend>{REQ_FIELDS.map(f =>
      <label key={f.k}>{f.label}<span className="unit-input"><input type="number" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={req[f.k]}
        onChange={e => setReq({ ...req, [f.k]: Number(e.target.value) })} /><em>{f.unit}</em></span></label>)}
      <label className="inline"><input type="checkbox" checked={req.requireCameraCoverage} onChange={e => setReq({ ...req, requireCameraCoverage: e.target.checked })} />要求每个工位都被检测相机看到</label>
    </fieldset>
    <p className={`plant-estimate ${area > req.maxFootprintArea ? "warn" : ""}`} aria-live="polite">按配方估算厂房 {hall.x.toFixed(1)} m × {hall.y.toFixed(2)} m = <strong>{area.toFixed(0)} m²</strong>
      {area > req.maxFootprintArea ? `，超过上限 ${req.maxFootprintArea} m²` : ""}；输送线 {(layout.stations * layout.stationPitch).toFixed(1)} m。结论只来自原生实测。</p>
    <div className="form-foot"><small>Blender 5.2 原生生成 → BVH 实测 → Cycles 渲染 → EvalArc 对照</small>
      <button type="button" disabled={c.busy} onClick={() => void runPlant(c, layout, req)}>生成并检查工厂产线</button></div>
  </Card>;
}

function plantRows(scene: PlantScene, which: "baseline" | "candidate"): MeasuredCheck[] {
  const checks = (scene[which]?.checks ?? []) as { id: string; passed: boolean; observed: number; required: number; perRobot?: number[] }[];
  const ge = (o: number, r: number) => r ? (o - r) / r : undefined, le = (o: number, r: number) => r ? (r - o) / r : undefined;
  return checks.map(x => {
    const title = PLANT_CHECK_LABELS[x.id] ?? x.id;
    if (x.id === "footprint-area") return { id: x.id, title, passed: x.passed, observed: x.observed.toFixed(0), required: `≤ ${x.required}`, unit: "m²", margin: le(x.observed, x.required), note: "厂房外包络" };
    if (x.id === "aisle-clearance") return { id: x.id, title, passed: x.passed, observed: x.observed.toFixed(2), required: `≥ ${x.required}`, unit: "m", margin: ge(x.observed, x.required), note: "41 截面 × 3 高度射线，最窄处" };
    if (x.id === "guard-clearance") return { id: x.id, title, passed: x.passed, observed: x.observed.toFixed(2), required: `≥ ${x.required}`, unit: "m", margin: x.required ? ge(x.observed, x.required) : undefined, note: "围栏距离 − 声明包络 1.45 m" };
    if (x.id === "camera-coverage") return { id: x.id, title, passed: x.passed, observed: String(x.observed), required: x.required ? `${x.required}` : "未要求", unit: "工位", margin: x.required ? (x.observed - x.required) / x.required : undefined, note: "首个命中为工件且在视锥内" };
    return { id: x.id, title, passed: x.passed, observed: x.observed.toFixed(1), required: `≤ ${x.required}`, unit: "m", margin: le(x.observed, x.required), note: "沿通道至最近出口" };
  });
}

/** Validate view of a plant review: live viewport (stages → animated scene), measured checks, renders and receipts. */
export function PlantDetail({ scene, Receipts }: { scene?: PlantScene; Receipts: (p: { value: unknown }) => React.ReactNode }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "blender-scene" && c.session.running;
  const model = viewportModel(c.session, scene, live ? c.session!.current ?? which : which);
  const v = scene ? verdictOf("blender-scene", scene.verdict, scene.state) : { label: "Blender 原生生成工厂产线中", tone: "live" as const };
  const derived = (scene?.candidate as { derived?: { hall: number[]; objects: number; animatedObjects: number } } | undefined)?.derived;
  const shown = which === "baseline" ? scene?.baseline : scene?.candidate;
  const rays = ((shown?.checks.find(x => x.id === "camera-coverage") as { rays?: { origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean }[] } | undefined)?.rays);
  return <>
    <Verdict tone={v.tone} eyebrow={`Blender 工厂产线评审${scene ? ` · ${scene.request.layout.stations} 工位 · ${scene.candidate?.blenderVersion ?? "Blender"}` : ""}`} title={v.label}
      detail={scene?.error ?? (scene?.state === "completed"
        ? `EvalArc 检测到 ${scene.diff?.blocking_changes ?? "—"} 项丢失的检查；${derived ? `厂房 ${derived.hall.join(" × ")} m，${derived.objects} 个原生对象，${derived.animatedObjects} 个动画对象。` : ""}合成配方，动画仅作演示，不含动力学与安全认证。`
        : "每完成一个构建阶段，原生几何即推送到视口；最终场景带 AGV、机器人与起重机动画。")} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={model && rays ? { ...model, rays } : model} /></Suspense>
    <div className="segmented" role="group" aria-label="布局">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "参考产线" : "候选产线"}</button>)}</div>
    {scene?.state === "completed" && <>
      <CheckTable caption={`${which === "baseline" ? "参考" : "候选"}产线 · Blender BVH 射线实测`} rows={plantRows(scene, which)}
        onAsk={row => c.askAI(`工厂产线候选的「${row.title}」实测 ${row.observed} ${row.unit}，要求 ${row.required} ${row.unit}，未通过。当前布局 ${JSON.stringify(scene.request.layout)}，`
          + `要求 ${JSON.stringify(scene.request.requirements)}。请引用检查记录解释原因，并用 plant-layout 给出不放宽任何要求的修正布局。`)} />
      <div className="scene-previews plant-renders">
        <figure className="hero"><img alt="候选产线原生 Cycles 渲染" src={`/api/scenes/${scene.id}/files/candidate/preview.png`} /><figcaption>候选产线 · Cycles 渲染（含屋顶与外墙）</figcaption></figure>
        <figure><img alt="governing 检测相机视角的 Cycles 渲染" src={`/api/scenes/${scene.id}/files/candidate/inspection.png`} /><figcaption>检测相机视角 · Cycles</figcaption></figure>
        <figure><img alt="参考产线原生 Cycles 渲染" src={`/api/scenes/${scene.id}/files/baseline/preview.png`} /><figcaption>参考产线（基准）</figcaption></figure>
      </div>
      <div className="button-row"><a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/scene.blend`}>下载 .blend</a>
        <a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/scene.glb`}>下载 GLB（含动画）</a></div>
      <Receipts value={{ request: scene.request, requirementDigest: scene.requirementDigest, receipts: scene.receipts, files: scene.files, derived }} />
    </>}
  </>;
}
