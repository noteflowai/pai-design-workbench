import { lazy, Suspense, useState } from "react";
import { api, requestIdFor } from "./api";
import { useApp, type Ctx } from "./context";
import { Card, CheckTable, Chip, Verdict, verdictOf, type MeasuredCheck } from "./ui";
import { viewportModel } from "./studio";
import type { AeroParameters, AeroRequirementsValue, AeroReview } from "../src/aero";

const Viewport = lazy(() => import("./viewport"));
export const AERO_CHECK_LABELS: Record<string, string> = { "drag-coefficient": "阻力系数 Cd", "grid-convergence": "网格收敛（两级）", "iterative-convergence": "迭代收敛", "mesh-quality": "网格质量" };
const FIELDS: { k: keyof AeroParameters; label: string; min: number; max: number; step: number; unit: string; scale?: number }[] = [
  { k: "slantAngleDeg", label: "后斜角", min: 0, max: 40, step: 0.5, unit: "°" }, { k: "noseRadius", label: "前端圆角", min: 50, max: 150, step: 1, unit: "mm", scale: 1000 },
  { k: "length", label: "车身长度", min: 800, max: 1300, step: 1, unit: "mm", scale: 1000 }, { k: "height", label: "车身高度", min: 240, max: 340, step: 1, unit: "mm", scale: 1000 },
];

export function runAero(c: Ctx, parameters: AeroParameters, requirements: AeroRequirementsValue) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-aero-${p.id}-${p.revision}-${JSON.stringify(parameters)}-${JSON.stringify(requirements)}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "aero-body" });
    const r = await c.track(requestId, `OpenFOAM 气动评审 · 后斜角 ${parameters.slantAngleDeg}°`, "aero-body",
      () => api<AeroReview>(`/projects/${p.id}/aero`, { requestId, projectRevision: p.revision, parameters, requirements }));
    c.navigate("validate", { kind: "aero-body", id: r.id });
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
  }, "OpenFOAM 两级网格求解与独立对照已完成。");
}

export function AeroLane() {
  const c = useApp();
  const cap = c.data.capabilities.aero;
  const last = (c.data.aeros ?? []).filter(a => a.projectId === c.project!.id).at(-1);
  const [params, setParams] = useState<AeroParameters>(() => last?.request.parameters ?? (cap ? cap.reference : { slantAngleDeg: 25, noseRadius: 0.1, length: 1.044, height: 0.288 }));
  const [req, setReq] = useState<AeroRequirementsValue>(() => last?.request.requirements ?? (cap ? cap.defaultRequirements : { maxDragCoefficient: 0.24, maxGridChange: 0.12, maxIterativeBand: 0.01 }));
  if (!cap) return <Card title="车身气动（OpenFOAM）"><p className="muted">未配置 OpenFOAM：设置 PAI_OPENFOAM_IMAGE（固定 digest 的 OpenCFD 官方镜像），并安装 CadQuery 与物理工具链。</p></Card>;
  return <Card title="车身气动（OpenFOAM CFD）" aside={<Chip tone="info">{cap.engine.split(" · ")[0]}</Chip>}>
    <p className="muted">CadQuery 生成 Ahmed 型车身（汽车空气动力学的标准基准体），OpenFOAM 用 snappyHexMesh 划分两级网格，simpleFoam（k-ω SST、移动地面、40 m/s）稳态求解阻力系数。
      检查阻力、两级网格变化、迭代收敛与网格质量；基准是 25° 参考车身，EvalArc 对照两者。稳态 RANS 用于设计比较，不等于风洞实测。</p>
    <fieldset className="field-grid"><legend>车身参数</legend>{FIELDS.map(f => <label key={f.k}>{f.label}<span className="unit-input">
      <input type="number" aria-label={f.label} min={f.min} max={f.max} step={f.step} value={+(params[f.k] * (f.scale ?? 1)).toFixed(3)}
        onChange={e => setParams({ ...params, [f.k]: Number(e.target.value) / (f.scale ?? 1) })} /><em>{f.unit}</em></span></label>)}</fieldset>
    <fieldset className="field-grid"><legend>气动要求</legend>
      <label>阻力系数上限<span className="unit-input"><input type="number" aria-label="阻力系数上限" min={0.05} max={2} step={0.005} value={req.maxDragCoefficient}
        onChange={e => setReq({ ...req, maxDragCoefficient: Number(e.target.value) })} /><em>Cd</em></span></label>
      <label>两级网格变化上限<span className="unit-input"><input type="number" aria-label="两级网格变化上限" min={0.5} max={50} step={0.5} value={+(req.maxGridChange * 100).toFixed(2)}
        onChange={e => setReq({ ...req, maxGridChange: Number(e.target.value) / 100 })} /><em>%</em></span></label>
    </fieldset>
    <div className="form-foot"><small>参考车身 + 候选车身，各两级网格 · 约 15–25 分钟</small>
      <button type="button" disabled={c.busy} onClick={() => void runAero(c, params, req)}>求解并检查车身</button></div>
  </Card>;
}

function rows(run: AeroReview, which: "baseline" | "candidate"): MeasuredCheck[] {
  return (run[which]?.checks ?? []).map(x => {
    const title = AERO_CHECK_LABELS[x.id] ?? x.id;
    if (x.id === "drag-coefficient") return { id: x.id, title, passed: x.passed, observed: x.observed.toFixed(4), required: `≤ ${x.required}`, unit: "", margin: (x.required - x.observed) / x.required, note: "细网格最后 100 步均值" };
    if (x.id === "mesh-quality") return { id: x.id, title, passed: x.passed, observed: String(x.observed), required: String(x.required), unit: "套网格", note: "checkMesh: Mesh OK" };
    return { id: x.id, title, passed: x.passed, observed: `${(x.observed * 100).toFixed(x.id === "iterative-convergence" ? 3 : 1)}%`, required: `≤ ${(x.required * 100).toFixed(1)}%`, unit: "",
      margin: (x.required - x.observed) / x.required, note: x.id === "grid-convergence" ? "level 3 与 level 4 的 Cd 相对差" : "最后 100 步 Cd 波动" };
  });
}

export function AeroDetail({ run }: { run?: AeroReview }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "aero-body" && c.session.running;
  const model = viewportModel(c.session, run, live ? c.session!.current ?? which : which, "aero-body");
  const v = run ? verdictOf("aero-body", run.verdict, run.state) : { label: "OpenFOAM 求解中", tone: "live" as const };
  const levels = run?.cfd?.[which]?.levels ?? [];
  return <>
    <Verdict tone={v.tone} eyebrow={`车身气动评审${run ? ` · 后斜角 ${run.request.parameters.slantAngleDeg}° · ${run.candidate?.engine ?? "OpenFOAM"}` : ""}`} title={v.label}
      detail={run?.error ?? (run?.state === "completed" ? `EvalArc 检测到 ${run.diff?.blocking_changes ?? "—"} 项丢失的检查。稳态 RANS（k-ω SST）两级网格，用于设计比较，不等于风洞实测。` : "CadQuery 车身 → snappyHexMesh 两级网格 → simpleFoam。")} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={model} /></Suspense>
    <div className="segmented" role="group" aria-label="车身">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "参考车身（25°）" : "候选车身"}</button>)}</div>
    {run?.state === "completed" && <>
      <CheckTable caption={`${which === "baseline" ? "参考" : "候选"}车身 · OpenFOAM 实测`} rows={rows(run, which)}
        onAsk={row => c.askAI(`车身气动候选的「${row.title}」实测 ${row.observed}，要求 ${row.required}，未通过。当前参数 ${JSON.stringify(run.request.parameters)}，`
          + `要求 ${JSON.stringify(run.request.requirements)}。请引用记录解释原因（结合后斜角分离与尾涡），并用 aero-body 给出不放宽要求的修正参数。`)} />
      <div className="table-wrap"><table className="sweep-table"><caption>网格层级（{which === "baseline" ? "参考" : "候选"}）</caption>
        <thead><tr><th scope="col">level</th><th scope="col">单元数</th><th scope="col">Cd</th><th scope="col">Cl</th><th scope="col">迭代</th><th scope="col">耗时 s</th></tr></thead>
        <tbody>{levels.map(l => <tr key={l.level}><td>{l.level}</td><td>{l.cells.toLocaleString()}</td><td>{l.cd}</td><td>{l.cl}</td><td>{l.iterations}</td><td>{l.seconds}</td></tr>)}</tbody></table></div>
      <div className="button-row"><a className="button secondary" href={`/api/aero/${run.id}/files/candidate/body.step`}>下载车身 STEP</a>
        <a className="button secondary" href={`/api/aero/${run.id}/files/candidate/forces-4.dat`}>下载力系数历史</a>
        <a className="button secondary" href={`/api/aero/${run.id}/files/candidate/cfd.json`}>下载 CFD 摘要</a></div>
    </>}
  </>;
}
