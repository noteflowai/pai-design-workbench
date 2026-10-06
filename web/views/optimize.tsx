import { useState } from "react";
import { api, requestIdFor } from "../api";
import { CAD_CHECK_LABELS, useApp, type Ctx } from "../context";
import { Card, Chip, time } from "../ui";
import { LiveSteps } from "../studio";
import type { CadRequirements, StructuralRequirements } from "../../src/cad";
import type { CadOptimization, OptimizePoint } from "../../src/optimize";

const ORIGIN: Record<string, string> = { reference: "参考件", "ai-seed": "AI 种子", initial: "初始 Sobol", screen: "几何筛除", exploit: "代理推荐", explore: "不确定性探索", bo: "BoTorch 采集" };
type Family = "nema17-bracket" | "pillow-block";
const familyOfRun = (r: CadOptimization): Family => (r.request as { family?: Family }).family ?? "nema17-bracket";
const label = (p: OptimizePoint) => { const q = p.parameters as Record<string, number>;
  return "thickness" in q ? `t=${q.thickness} · W=${q.width} · H=${q.plateHeight}` : `W=${q.width} · D=${q.depth} · 底座 ${q.baseThickness} · 孔距 ${q.boltPitch}`; };
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

type Strategy = "gp-nsga2" | "botorch-qlognehvi";
function runOptimize(c: Ctx, requirements: CadRequirements, strategy: Strategy = "gp-nsga2", family: Family = "nema17-bracket") {
  const p = c.project!;
  const requestId = requestIdFor(`pai-optimize-${p.id}-${p.revision}-${family}-${JSON.stringify(requirements)}-${strategy}`);
  return c.perform(async () => {
    const r = await c.track(requestId, "物理寻优 · CalculiX + 代理模型", "cad-optimize",
      () => api<CadOptimization>(`/projects/${p.id}/cad-optimizations`, { requestId, projectRevision: p.revision, requirements, strategy, ...(family === "pillow-block" ? { family, solver: "local" } : {}) }));
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
  }, "物理寻优完成：报告的每个点都由 CadQuery 与 CalculiX 实测。");
}

function formalize(c: Ctx, run: CadOptimization, point: OptimizePoint) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-cad-optimize-${run.id}-${point.index}-${p.revision}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "cad-part" });
    const r = await c.track(requestId, `寻优候选 · ${label(point)}`, "cad-part", () => api<{ id: string; state: string; error?: string }>(`/projects/${p.id}/cad`,
      { requestId, projectRevision: p.revision, variant: "parametric", requirements: run.request.requirements, parameters: point.parameters,
        ...(familyOfRun(run) === "pillow-block" ? { family: "pillow-block" } : {}), fromOptimize: { optimizeId: run.id, point: point.index } }));
    c.navigate("validate", { kind: "cad-part", id: r.id });
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
  }, "已把寻优点作为正式候选：两级网格 FEA、基准对照与 EvalArc 已完成。");
}

/** Mass (x) against measured motor-axis deflection (y, log); the frozen limit is the horizontal line. */
function Plot({ run, selected, onSelect }: { run: CadOptimization; selected?: number; onSelect: (i: number) => void }) {
  // Bracket: motor-axis deflection decides; pillow block: the seat out-of-roundness is the binding limit.
  const pillow = familyOfRun(run) === "pillow-block";
  const metric = (p: OptimizePoint) => pillow ? p.boreDistortionMm : p.deflectionMm;
  const points = run.result!.points.filter(p => metric(p) !== undefined && p.mass !== undefined);
  const limit = pillow ? run.request.requirements.structural!.maxBoreDistortionMm! : run.request.requirements.structural!.maxDeflectionMm;
  const W = 540, H = 250, pad = { l: 52, r: 14, t: 12, b: 34 };
  const xs = points.map(p => p.mass!), ly = points.map(p => Math.log10(metric(p)!)).concat(Math.log10(limit));
  const [x0, x1] = [Math.min(...xs) * 0.94, Math.max(...xs) * 1.04], [y0, y1] = [Math.min(...ly) - 0.08, Math.max(...ly) + 0.08];
  const X = (v: number) => pad.l + (v - x0) / (x1 - x0) * (W - pad.l - pad.r), Y = (v: number) => H - pad.b - (Math.log10(v) - y0) / (y1 - y0) * (H - pad.t - pad.b);
  const front = new Set(run.result!.pareto);
  return <svg className="sweep-plot" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={pillow ? "质量与实测轴承孔失圆散点图" : "质量与实测挠度散点图"}>
    <line x1={pad.l} x2={W - pad.r} y1={Y(limit)} y2={Y(limit)} className="req" />
    <text x={W - pad.r} y={Y(limit) - 4} textAnchor="end" className="req-label">{pillow ? `失圆上限 ${limit * 1000} µm` : `挠度上限 ${limit} mm`}</text>
    <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="axis" /><line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} className="axis" />
    <text x={(W + pad.l) / 2} y={H - 6} textAnchor="middle" className="axis-label">质量 g（B-Rep 实测）</text>
    <text x={12} y={(H - pad.b) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 12 ${(H - pad.b) / 2})`}>CalculiX {pillow ? "轴承孔失圆" : "电机轴挠度"} mm（对数）</text>
    {[x0, (x0 + x1) / 2, x1].map(v => <text key={v} x={X(v)} y={H - pad.b + 14} textAnchor="middle" className="tick">{v.toFixed(0)}</text>)}
    {[y0, (y0 + y1) / 2, y1].map(v => <text key={v} x={pad.l - 6} y={Y(10 ** v) + 3} textAnchor="end" className="tick">{(10 ** v).toFixed(familyOfRun(run) === "pillow-block" ? 4 : 3)}</text>)}
    {points.map(p => <g key={p.index}>
      {front.has(p.index) && <circle cx={X(p.mass!)} cy={Y(metric(p)!)} r={9} className="pareto" />}
      {p.origin === "ai-seed" ? <rect x={X(p.mass!) - 5.5} y={Y(metric(p)!) - 5.5} width={11} height={11} transform={`rotate(45 ${X(p.mass!)} ${Y(metric(p)!)})`}
        className={`pt ${p.feasible ? "ok" : "bad"} ${selected === p.index ? "sel" : ""}`} tabIndex={0} role="button" aria-label={`AI 种子点 ${p.index}：${label(p)}`} onClick={() => onSelect(p.index)} />
        : <circle cx={X(p.mass!)} cy={Y(metric(p)!)} r={selected === p.index ? 6.5 : p.origin === "exploit" || p.origin === "explore" ? 5.5 : 4.5}
          className={`pt ${p.feasible ? "ok" : "bad"} ${p.origin} ${selected === p.index ? "sel" : ""}`} tabIndex={0} role="button"
          aria-label={`点 ${p.index}（${ORIGIN[p.origin]}）：${label(p)}，${p.mass} g，挠度 ${p.deflectionMm} mm，${p.feasible ? "全部通过" : `未通过 ${p.failed.map(f => CAD_CHECK_LABELS[f] ?? f).join("、")}`}`}
          onClick={() => onSelect(p.index)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.index); } }}><title>{ORIGIN[p.origin]} · {label(p)}</title></circle>}
    </g>)}
  </svg>;
}

export function OptimizePanel({ requirements, family = "nema17-bracket" }: { requirements: CadRequirements; family?: Family }) {
  const c = useApp();
  const physics = c.data.capabilities.physics;
  const pillow = family === "pillow-block";
  const runs = (c.data.cadOptimizations ?? []).filter(s => s.projectId === c.project?.id && familyOfRun(s) === family);
  const latest = runs.at(-1);
  const [chosen, setChosen] = useState<number>();
  const [strategy, setStrategy] = useState<Strategy>("gp-nsga2");
  if (!physics) return <Card title="物理寻优（FEA + 代理模型）"><p className="muted">未配置物理工具链：运行 npm run setup:physics（Gmsh、CalculiX、Optuna、scikit-learn、MuJoCo）。</p></Card>;
  const structural: StructuralRequirements = requirements.structural ?? physics.familyStructural?.[family] ?? physics.defaultStructural;
  const result = latest?.result;
  const selected = result?.points.find(p => p.index === (chosen ?? result.lightestFeasible ?? undefined));
  const live = c.session?.kind === "cad-optimize" && (c.session.running || c.session.recordId === latest?.id) ? c.session : undefined;
  const madeFrom = (index: number) => (c.data.cads ?? []).find(x => x.request.fromOptimize?.optimizeId === latest?.id && x.request.fromOptimize?.point === index);
  const meanCal = result?.calibration.length ? result.calibration.reduce((s, x) => s + x.relativeError, 0) / result.calibration.length : undefined;
  const solved = result?.points.filter(p => p.fidelity === "fea").length ?? 0, screened = result?.points.filter(p => p.fidelity === "geometry").length ?? 0;
  return <Card title="物理寻优（FEA + 代理模型）" aside={<small>代理模型只排序 · 结论只认实测点</small>}>
    <p className="muted">{pillow ? <>轴承径向载荷 {structural.forceN} N（{structural.direction === "toward-base" ? "指向底座" : "背离底座"}），轴心位移 ≤ {structural.maxDeflectionMm} mm、轴承孔失圆 ≤ {(structural.maxBoreDistortionMm ?? 0) * 1000} µm，
      安全系数 {structural.safetyFactor}；搜索底座长度、厚度、底座厚度和孔距，其余尺寸固定。</> : <>载荷 {structural.forceN} N、力臂 {structural.leverMm} mm，挠度 ≤ {structural.maxDeflectionMm} mm，安全系数 {structural.safetyFactor}（6061-T6 名义值）。</>}
      先测参考件、AI 种子和 Sobol 初始点；之后每轮用高斯过程代理模型和 NSGA-II 排序候选，先做 B-Rep 几何筛查，再用 CalculiX 求解，并把代理模型的预测和实测一起记录下来。</p>
    <div className="form-foot"><small>约 {physics.optimize.defaultBudget.initial + 1 + physics.optimize.defaultBudget.rounds * physics.optimize.defaultBudget.perRound} 次 FEA · 约 8–15 分钟 · 也可以让 AI 助手给出带物理估算的种子</small>
      <label className="inline">搜索策略<select aria-label="搜索策略" value={strategy} onChange={e => setStrategy(e.target.value as Strategy)}>
        <option value="gp-nsga2">GP 代理 + NSGA-II（默认）</option>
        <option value="botorch-qlognehvi" disabled={pillow || !physics.optimize.strategies?.includes("botorch-qlognehvi")}>BoTorch qLogNEHVI（约束批量贝叶斯优化）{physics.optimize.botorch ? ` ${physics.optimize.botorch}` : " · 未安装"}</option>
      </select></label>
      <button type="button" disabled={c.busy} onClick={() => void runOptimize(c, { ...requirements, structural }, pillow ? "gp-nsga2" : strategy, family)}>运行物理寻优</button></div>
    {live && <LiveSteps session={{ ...live, steps: live.steps.filter(s => s.id === "optimize").concat(live.steps.filter(s => s.id !== "optimize").slice(-5)) }} />}
    {latest?.state === "failed" && <p className="warning">⚠ {latest.error}</p>}
    {result && <>
      <p className="muted">{time(latest!.createdAt)} · {solved} 个点完成 FEA，{result.points.filter(p => p.fidelity === "geometry" && p.feasible === false).length} 个点在几何筛查阶段被排除{screened - result.points.filter(p => p.fidelity === "geometry" && p.feasible === false).length > 0 ? `，${screened - result.points.filter(p => p.fidelity === "geometry" && p.feasible === false).length} 个只做了几何筛查（多保真先验，未求解）` : ""}{result.strategy === "botorch-qlognehvi" ? " · 策略：BoTorch qLogNEHVI" : ""}{latest!.warmStart?.points ? ` · 预热：复用 ${latest!.warmStart.points} 个已有实测点训练代理模型（不作为本次结果）` : ""}{latest!.solver === "batch" ? ` · 求解：AWS Batch（${result.points.filter(p => p.remote).length} 个作业，摘要与版本已核对）` : ""} · {result.feasibleCount} 个点满足全部 9 项检查
        {meanCal !== undefined ? ` · 代理模型挠度预测平均误差 ${pct(meanCal)}` : ""}。</p>
      <Plot run={latest!} selected={selected?.index} onSelect={setChosen} />
      <p className="legend"><span className="dot ok" />全部通过 <span className="dot bad" />有未通过的检查 <span className="dot ring" />可行点的帕累托前沿（更轻 / 更刚）◆ AI 种子</p>
      {selected && <div className="sweep-pick" aria-live="polite">
        <strong>点 {selected.index} · {ORIGIN[selected.origin]} · {label(selected)}</strong>
        <span>{selected.mass ?? "—"} g · {pillow ? "轴心位移" : "挠度"} {selected.deflectionMm ?? "—"} mm{selected.boreDistortionMm !== undefined ? ` · 失圆 ${(selected.boreDistortionMm * 1000).toFixed(2)} µm` : ""} · 应力 {selected.stressMPa ?? "—"} MPa
          {selected.prediction ? ` · 代理预测 ${selected.prediction.deflectionMm} mm` : ""}{selected.estimate?.expectedDeflectionMm ? ` · AI 估算 ${selected.estimate.expectedDeflectionMm} mm` : ""} ·{" "}
          {selected.feasible ? <Chip tone="ok">全部通过</Chip> : <Chip tone="bad">未通过：{selected.failed.map(f => CAD_CHECK_LABELS[f] ?? f).join("、")}</Chip>}</span>
        {selected.fidelity === "fea" && (madeFrom(selected.index)
          ? <button type="button" className="secondary" onClick={() => c.navigate("validate", { kind: "cad-part", id: madeFrom(selected.index)!.id })}>查看已生成的候选 →</button>
          : <button type="button" disabled={c.busy} onClick={() => void formalize(c, latest!, selected)}>以此参数生成正式候选（两级网格复核）</button>)}
      </div>}
      <div className="table-wrap"><table className="sweep-table"><caption>代理模型 · 每轮留一法误差（对数挠度）与本轮推荐点</caption>
        <thead><tr><th scope="col">轮次</th><th scope="col">训练点</th><th scope="col">留一法误差</th><th scope="col">几何筛查</th><th scope="col">求解的点</th></tr></thead>
        <tbody>{result.rounds.map(r => <tr key={r.round}><td>{r.round}</td><td>{r.trainedOn}</td><td>{r.looMeanAbsError.logDeflection}</td><td>{r.screenedGeometry}</td><td>{r.proposed.map(i => `#${i}`).join(" ")}</td></tr>)}</tbody></table></div>
      {result.aiSeeds.length > 0 && <div className="table-wrap"><table className="sweep-table"><caption>AI 物理估算与 CalculiX 实测对照</caption>
        <thead><tr><th scope="col">点</th><th scope="col">AI 估算挠度</th><th scope="col">实测</th><th scope="col">相对误差</th></tr></thead>
        <tbody>{result.aiSeeds.map(s => <tr key={s.index}><td>#{s.index}</td><td>{s.expected ?? "—"}</td><td>{s.measured ?? "—"}</td><td>{s.relativeError === null ? "—" : pct(s.relativeError)}</td></tr>)}</tbody></table></div>}
    </>}
  </Card>;
}
