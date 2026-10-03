import { lazy, Suspense, useState } from "react";
import { api, requestIdFor } from "./api";
import { useApp, type Ctx } from "./context";
import { Card, CheckTable, Chip, Verdict, verdictOf, type MeasuredCheck } from "./ui";
import { viewportModel } from "./studio";
import type { SceneReview } from "../src/scenes";

const Viewport = lazy(() => import("./viewport"));
type Cell = { pickDistance: number; placeDistance: number; pickHeight: number; placeHeight: number; pedestalHeight: number; guardClearance: number; speedFraction: number; jitter: number };
type Req = { maxCycleSeconds: number; minSuccessRate: number };
type Trial = { seed: number; success: boolean; reached: boolean; collisionFree: boolean; cycleSeconds: number };
type Tool = { cadReviewId: string; payloadKg: number };
export type RobotScene = SceneReview & { request: { variant: "robot-cell"; cell: Cell; requirements: Req; tool?: Tool } };
export const isRobotScene = (s?: SceneReview): s is RobotScene => s?.request.variant === "robot-cell";
export const ROBOT_CHECK_LABELS: Record<string, string> = { reach: "机械臂可达", "collision-free": "运动无碰撞", "cycle-time": "节拍", "success-rate": "多种子成功率" };
const REFERENCE: Cell = { pickDistance: 0.55, placeDistance: 0.55, pickHeight: 0.85, placeHeight: 0.85, pedestalHeight: 0.7, guardClearance: 0.4, speedFraction: 0.5, jitter: 0.03 };
const DEFAULT_REQ: Req = { maxCycleSeconds: 6, minSuccessRate: 0.9 };
const FIELDS: { k: keyof Cell; label: string; min: number; max: number; step: number; unit: string; scale?: number }[] = [
  { k: "pickDistance", label: "取料点距离", min: 0.25, max: 1.1, step: 0.01, unit: "m" }, { k: "placeDistance", label: "放料点距离", min: 0.25, max: 1.1, step: 0.01, unit: "m" },
  { k: "pickHeight", label: "取料高度", min: 0.6, max: 1.2, step: 0.01, unit: "m" }, { k: "placeHeight", label: "放料高度", min: 0.6, max: 1.2, step: 0.01, unit: "m" },
  { k: "pedestalHeight", label: "底座高度", min: 0.3, max: 1, step: 0.01, unit: "m" }, { k: "guardClearance", label: "围栏离最远工位", min: 0.1, max: 1.5, step: 0.01, unit: "m" },
  { k: "speedFraction", label: "关节速度", min: 10, max: 100, step: 1, unit: "%", scale: 100 }, { k: "jitter", label: "来料位置偏差 ±", min: 0, max: 80, step: 1, unit: "mm", scale: 1000 },
];

export function runRobotCell(c: Ctx, cell: Cell, requirements: Req, tool?: Tool) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-robot-${p.id}-${p.revision}-${JSON.stringify(cell)}-${JSON.stringify(requirements)}-${JSON.stringify(tool ?? null)}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "blender-scene" });
    const s = await c.track(requestId, `MuJoCo 机器人工作单元 · 速度 ${Math.round(cell.speedFraction * 100)}%`, "blender-scene",
      () => api<SceneReview>(`/projects/${p.id}/scenes`, { requestId, projectRevision: p.revision, variant: "robot-cell", cell, requirements, ...(tool ? { tool } : {}) }));
    c.navigate("validate", { kind: "blender-scene", id: s.id });
    if (s.state !== "completed") throw new Error(s.error ?? s.state);
  }, "MuJoCo 多种子仿真与独立对照已完成。");
}

export function RobotLaneCell() {
  const c = useApp();
  const q = c.route.params;
  const last = c.data.scenes.filter(s => s.projectId === c.project!.id && isRobotScene(s)).at(-1) as RobotScene | undefined;
  const [cell, setCell] = useState<Cell>(() => Object.fromEntries(Object.entries(last?.request.cell ?? REFERENCE).map(([k, v]) => [k, q.has(k) ? Number(q.get(k)) : v])) as Cell);
  const [req, setReq] = useState<Req>(last?.request.requirements ?? DEFAULT_REQ);
  // Accepted CAD parts of this project can be mounted on the gripper (exact mesh mass/inertia, B-Rep cross-check).
  const parts = (c.data.cads ?? []).filter(x => x.projectId === c.project!.id && x.verdict === "accepted-cad-part");
  const [toolId, setToolId] = useState<string>(last?.request.tool?.cadReviewId ?? "");
  const tool = parts.some(x => x.id === toolId) ? { cadReviewId: toolId, payloadKg: 0.28 } : undefined;
  const partLabel = (x: (typeof parts)[number]) => { const m = x.candidate?.checks.find(k => k.id === "mass") as { observed?: number } | undefined;
    return `cad-${(c.data.cads ?? []).filter(y => y.projectId === c.project!.id).indexOf(x) + 1} · ${x.request.variant}${m?.observed ? ` · ${m.observed} g` : ""}`; };
  if (!c.data.capabilities.physics) return <Card title="机器人工作单元（MuJoCo）"><p className="muted">未配置物理工具链：运行 npm run setup:physics。</p></Card>;
  return <Card title="机器人工作单元（MuJoCo 刚体动力学）" aside={<Chip tone="info">通用六轴臂 · UR5e 级连杆</Chip>}>
    <p className="muted">按参数生成 MJCF：六轴机械臂、底座、输送线取料点、工装放料点和四面围栏。用 10 个固定种子模拟来料位置偏差，每个种子都做逆运动学、五次多项式轨迹和 500 Hz 动力学仿真，
      实测可达性、连杆与围栏/设备的碰撞、节拍，并统计成功率。基准是参考工作单元；EvalArc 检查候选有没有丢失基准通过的项。</p>
    <fieldset className="field-grid"><legend>工作单元参数</legend>{FIELDS.map(f => <label key={f.k}>{f.label}<span className="unit-input">
      <input type="number" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={+(cell[f.k] * (f.scale ?? 1)).toFixed(3)}
        onChange={e => setCell({ ...cell, [f.k]: Number(e.target.value) / (f.scale ?? 1) })} /><em>{f.unit}</em></span></label>)}</fieldset>
    <fieldset className="field-grid"><legend>系统要求</legend>
      <label>节拍上限<span className="unit-input"><input type="number" aria-label="节拍上限" min={1} max={60} step={0.1} value={req.maxCycleSeconds} onChange={e => setReq({ ...req, maxCycleSeconds: Number(e.target.value) })} /><em>s</em></span></label>
      <label>成功率下限<span className="unit-input"><input type="number" aria-label="成功率下限" min={0} max={100} step={1} value={Math.round(req.minSuccessRate * 100)} onChange={e => setReq({ ...req, minSuccessRate: Number(e.target.value) / 100 })} /><em>%</em></span></label>
    </fieldset>
    <fieldset className="field-grid"><legend>末端工装</legend>
      <label>CAD 零件<select aria-label="末端工装 CAD 零件" value={tool ? toolId : ""} onChange={e => setToolId(e.target.value)}>
        <option value="">默认夹爪（不加装）</option>{parts.map(x => <option key={x.id} value={x.id}>{partLabel(x)}</option>)}</select></label>
      <p className="muted">装到夹爪侧面，加 0.28 kg NEMA 17 电机负载。质量和惯量取自已核验的 STL 精确体积，并与 B-Rep 质量交叉核对（差值 ≤ 3 %）；参考与候选工作单元使用同一工装。</p>
    </fieldset>
    <div className="form-foot"><small>MuJoCo 3.14 · 逆运动学 + 动力学 · 10 个种子 · EvalArc 对照 · 导出 MJCF 与 OpenUSD</small>
      <button type="button" disabled={c.busy} onClick={() => void runRobotCell(c, cell, req, tool)}>仿真并检查工作单元</button></div>
  </Card>;
}

function rows(scene: RobotScene, which: "baseline" | "candidate"): MeasuredCheck[] {
  return ((scene[which]?.checks ?? []) as { id: string; passed: boolean; observed: number | null; required: number }[]).map(x => {
    const title = ROBOT_CHECK_LABELS[x.id] ?? x.id;
    if (x.id === "cycle-time") return { id: x.id, title, passed: x.passed, observed: x.observed === null ? "—" : x.observed.toFixed(2), required: `≤ ${x.required}`, unit: "s",
      margin: x.observed === null ? undefined : (x.required - x.observed) / x.required, note: "最慢种子 · 含稳定时间" };
    if (x.id === "success-rate") return { id: x.id, title, passed: x.passed, observed: `${Math.round((x.observed ?? 0) * 100)}%`, required: `≥ ${Math.round(x.required * 100)}%`, unit: "",
      margin: x.required ? ((x.observed ?? 0) - x.required) / x.required : undefined, note: "可达 ∧ 无碰撞 ∧ 节拍达标" };
    return { id: x.id, title, passed: x.passed, observed: String(x.observed), required: String(x.required), unit: "种子", note: x.id === "reach" ? "IK 误差 ≤ 2 mm" : "连杆与围栏/输送线/工装接触" };
  });
}

export function RobotDetail({ scene, Receipts }: { scene?: RobotScene; Receipts: (p: { value: unknown }) => React.ReactNode }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "blender-scene" && c.session.running;
  const model = viewportModel(c.session, scene, live ? c.session!.current ?? which : which);
  const shown = model && scene?.state === "completed" ? { ...model, finalUrl: `/api/scenes/${scene.id}/files/${which}/robot.glb` } : model;
  const v = scene ? verdictOf("blender-scene", scene.verdict, scene.state) : { label: "MuJoCo 仿真中", tone: "live" as const };
  const trials = (w: "baseline" | "candidate") => ((scene?.[w] as { trials?: Trial[] } | undefined)?.trials ?? []);
  const lost = trials("baseline").filter(b => b.success && trials("candidate").find(t => t.seed === b.seed)?.success === false).map(b => b.seed);
  return <>
    <Verdict tone={v.tone} eyebrow={`MuJoCo 机器人工作单元评审${scene ? ` · 速度 ${Math.round(scene.request.cell.speedFraction * 100)}% · ${(scene.candidate as { engine?: string } | undefined)?.engine ?? "MuJoCo"}` : ""}`} title={v.label}
      detail={scene?.error ?? (scene?.state === "completed" ? `EvalArc 检测到 ${scene.diff?.blocking_changes ?? "—"} 项丢失的检查；配对种子中丢失 ${lost.length} 个基准成功样本${lost.length ? `（seed ${lost.join(", ")}）` : ""}。刚体仿真，不代表厂商控制器或安全评估。`
        : "逐种子仿真：逆运动学、轨迹、500 Hz 动力学与接触检测。")} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={shown} /></Suspense>
    <div className="segmented" role="group" aria-label="工作单元">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "参考工作单元" : "候选工作单元"}</button>)}</div>
    {scene?.state === "completed" && <>
      <CheckTable caption={`${which === "baseline" ? "参考" : "候选"}工作单元 · MuJoCo 实测`} rows={rows(scene, which)}
        onAsk={row => c.askAI(`机器人工作单元候选的「${row.title}」实测 ${row.observed} ${row.unit}，要求 ${row.required} ${row.unit}，未通过。当前参数 ${JSON.stringify(scene.request.cell)}，`
          + `要求 ${JSON.stringify(scene.request.requirements)}。请引用记录解释原因，并用 robot-cell 给出不放宽要求的修正参数。`)} />
      <div className="table-wrap"><table className="sweep-table"><caption>配对种子（同一来料偏差）</caption>
        <thead><tr><th scope="col">seed</th><th scope="col">参考</th><th scope="col">候选</th><th scope="col">候选节拍 s</th></tr></thead>
        <tbody>{trials("candidate").map(t => { const b = trials("baseline").find(x => x.seed === t.seed);
          return <tr key={t.seed} className={b?.success && !t.success ? "fail" : ""}><td>{t.seed}</td><td>{b ? (b.success ? "✓" : "×") : "—"}</td>
            <td>{t.success ? "✓" : `× ${!t.reached ? "不可达" : !t.collisionFree ? "碰撞" : "超节拍"}`}</td><td>{t.cycleSeconds}</td></tr>; })}</tbody></table></div>
      <div className="button-row"><a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/scene.xml`}>下载 MJCF（scene.xml）</a>
        <a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/scene.usda`}>下载 OpenUSD（UsdPhysics）</a>
        <a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/robot.json`}>下载逐种子结果</a></div>
      {(scene.tool || scene.usd) && <p className="muted">{scene.tool && <>末端工装：CAD 零件 STL {scene.tool.stlSha256.slice(0, 12)}…，B-Rep {scene.tool.brepMassG} g / MuJoCo 网格 {scene.tool.mujocoMassG ?? "—"} g，负载 {scene.tool.payloadKg} kg。</>}
        {scene.usd && <>OpenUSD {scene.usd.usdVersion}：{scene.usd.rigidBodies} 个刚体、{scene.usd.joints.length} 个关节，{scene.usd.validators} 个 UsdValidation 校验器无错误，可导入 Isaac Sim / Omniverse。</>}</p>}
      <Receipts value={{ request: scene.request, requirementDigest: scene.requirementDigest, receipts: scene.receipts, files: scene.files }} />
    </>}
  </>;
}
