import { useMemo, useState } from "react";
import { api, requestIdFor } from "../api";
import { CAD_CHECK_LABELS, useApp, type Ctx } from "../context";
import { Card, Chip, time } from "../ui";
import { LiveSteps } from "../studio";
import type { CadRequirements } from "../../src/cad";
import type { CadSweep, SweepGrid, SweepPoint } from "../../src/sweep";

const AXES: [keyof SweepGrid, string, string][] = [["thickness", "板厚 t", "mm"], ["width", "宽度 W", "mm"], ["plateHeight", "安装板高度 H", "mm"], ["pilotBore", "止口孔径", "mm"]];
const parse = (text: string) => [...new Set(text.split(/[,，\s]+/).filter(Boolean).map(Number))];
const count = (g: Record<string, number[]>) => Object.values(g).reduce((n, v) => n * v.length, 1);
const minWall = (p: SweepPoint) => Number(p.checks?.find(c => c.id === "min-wall")?.observed ?? NaN);
const label = (p: SweepPoint) => `t=${p.parameters.thickness} · W=${p.parameters.width} · H=${p.parameters.plateHeight} · Ø${p.parameters.pilotBore}`;

function runSweep(c: Ctx, requirements: CadRequirements, grid: SweepGrid) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-sweep-${p.id}-${p.revision}-${JSON.stringify(requirements)}-${JSON.stringify(grid)}`);
  return c.perform(async () => {
    const r = await c.track(requestId, `设计空间扫描 · ${count(grid)} 个点`, "cad-sweep",
      () => api<CadSweep>(`/projects/${p.id}/cad-sweeps`, { requestId, projectRevision: p.revision, requirements, grid }));
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
  }, "设计空间扫描完成：每个点都已原生建模并实测。");
}

function choosePoint(c: Ctx, sweep: CadSweep, point: SweepPoint) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-cad-sweep-${sweep.id}-${point.index}-${p.revision}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "cad-part" });
    const r = await c.track(requestId, `参数化候选 · ${label(point)}`, "cad-part", () => api<{ id: string; state: string; error?: string }>(`/projects/${p.id}/cad`,
      { requestId, projectRevision: p.revision, variant: "parametric", requirements: sweep.request.requirements, parameters: point.parameters, fromSweep: { sweepId: sweep.id, point: point.index } }));
    c.navigate("validate", { kind: "cad-part", id: r.id });
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
  }, "已把扫描点作为正式候选：基准对照、EvalArc 与可编辑 STEP 均已生成。");
}

/** Accessible scatter: mass (x) against measured minimum wall (y); feasible points filled, Pareto points ringed. */
function Scatter({ sweep, selected, onSelect }: { sweep: CadSweep; selected?: number; onSelect: (i: number) => void }) {
  const points = sweep.result!.points.filter(p => typeof p.mass === "number");
  const req = sweep.request.requirements;
  const W = 520, H = 240, pad = { l: 46, r: 12, t: 12, b: 34 };
  const xs = points.map(p => p.mass!), ys = points.map(minWall).filter(Number.isFinite);
  const [x0, x1] = [Math.min(...xs) * 0.95, Math.max(...xs, req.maxMassG > Math.max(...xs) * 1.3 ? 0 : req.maxMassG) * 1.03];
  const [y0, y1] = [Math.min(...ys, req.minWallMm) * 0.85, Math.max(...ys, req.minWallMm) * 1.1];
  const X = (v: number) => pad.l + (v - x0) / (x1 - x0) * (W - pad.l - pad.r), Y = (v: number) => H - pad.b - (v - y0) / (y1 - y0) * (H - pad.t - pad.b);
  const pareto = new Set(sweep.pareto ?? []);
  return <svg className="sweep-plot" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="质量与最小壁厚散点图">
    <line x1={pad.l} x2={W - pad.r} y1={Y(req.minWallMm)} y2={Y(req.minWallMm)} className="req" />
    <text x={W - pad.r} y={Y(req.minWallMm) - 4} textAnchor="end" className="req-label">最小壁厚 {req.minWallMm} mm</text>
    <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="axis" /><line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} className="axis" />
    <text x={(W + pad.l) / 2} y={H - 6} textAnchor="middle" className="axis-label">质量 g（实测体积 × 2.70 g/cm³）</text>
    <text x={12} y={(H - pad.b) / 2} textAnchor="middle" className="axis-label" transform={`rotate(-90 12 ${(H - pad.b) / 2})`}>实测最小壁厚 mm</text>
    {[x0, (x0 + x1) / 2, x1].map(v => <text key={v} x={X(v)} y={H - pad.b + 14} textAnchor="middle" className="tick">{v.toFixed(0)}</text>)}
    {[y0, (y0 + y1) / 2, y1].map(v => <text key={v} x={pad.l - 6} y={Y(v) + 3} textAnchor="end" className="tick">{v.toFixed(1)}</text>)}
    {points.map(p => <g key={p.index}>
      {pareto.has(p.index) && <circle cx={X(p.mass!)} cy={Y(minWall(p))} r={9} className="pareto" />}
      <circle cx={X(p.mass!)} cy={Y(minWall(p))} r={selected === p.index ? 6.5 : 5} className={`pt ${p.feasible ? "ok" : "bad"} ${selected === p.index ? "sel" : ""}`}
        tabIndex={0} role="button" aria-label={`点 ${p.index}：${label(p)}，${p.mass} g，${p.feasible ? "全部通过" : `未通过 ${p.failed.map(f => CAD_CHECK_LABELS[f] ?? f).join("、")}`}`}
        onClick={() => onSelect(p.index)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.index); } }}><title>{label(p)} · {p.mass} g</title></circle>
    </g>)}
  </svg>;
}

export function SweepPanel({ requirements }: { requirements: CadRequirements }) {
  const c = useApp();
  const cap = c.data.capabilities.cad;
  const defaults = cap && cap.sweep ? cap.sweep.defaultGrid : { thickness: [2.5, 3, 3.5, 4], width: [50, 55, 60], plateHeight: [43.5, 46], pilotBore: [22.5] };
  const max = cap && cap.sweep ? cap.sweep.maxPoints : 36;
  const sweeps = (c.data.cadSweeps ?? []).filter(s => s.projectId === c.project?.id);
  const latest = sweeps.at(-1);
  // Start from the grid of the sweep on screen, so the inputs always describe what is shown.
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(AXES.map(([k]) => [k, (latest?.request.grid ?? defaults)[k].join(", ")])));
  const grid = Object.fromEntries(AXES.map(([k]) => [k, parse(text[k])])) as SweepGrid;
  const valid = AXES.every(([k]) => grid[k].length > 0 && grid[k].every(Number.isFinite)) && count(grid) <= max;
  const [chosen, setChosen] = useState<number>();
  const rows = useMemo(() => latest?.result ? [...latest.result.points].sort((a, b) => Number(b.feasible) - Number(a.feasible) || (a.mass ?? 1e9) - (b.mass ?? 1e9)) : [], [latest]);
  const selected = latest?.result?.points.find(p => p.index === (chosen ?? latest.result!.lightestFeasible ?? undefined));
  const live = c.session?.kind === "cad-sweep" && (c.session.running || c.session.recordId === latest?.id) ? c.session : undefined;
  const madeFrom = (index: number) => (c.data.cads ?? []).find(x => x.request.fromSweep?.sweepId === latest?.id && x.request.fromSweep?.point === index);
  return <Card title="设计空间扫描" aside={<small>每个点原生建模并实测 · 只用于探索，不作结论</small>}>
    <div className="field-grid sweep-axes">{AXES.map(([k, name, unit]) => <label key={k}>{name}<span className="unit-input">
      <input value={text[k]} onChange={e => setText({ ...text, [k]: e.target.value })} aria-describedby="sweep-count" inputMode="decimal" /><em>{unit}</em></span></label>)}</div>
    <div className="form-foot"><small id="sweep-count">{count(grid)} 个点（上限 {max}）· 约 {Math.ceil(count(grid) * 6 / 60)} 分钟 · 使用上方零件要求</small>
      <button type="button" disabled={c.busy || !valid} onClick={() => void runSweep(c, requirements, grid)}>运行扫描</button></div>
    {live && <LiveSteps session={{ ...live, steps: live.steps.filter(s => s.id === "sweep").concat(live.steps.filter(s => s.id !== "sweep").slice(-4)) }} />}
    {latest?.state === "failed" && <p className="warning">⚠ {latest.error}</p>}
    {latest?.result && <>
      <p className="muted">{time(latest.createdAt)} · 需求 v{latest.projectRevision} · {latest.result.points.length} 个点中 {latest.result.feasibleCount} 个满足全部 7 项检查
        {selected?.feasible && latest.result.lightestFeasible === selected.index ? ` · 最轻可行点 ${selected.mass} g` : ""}。只比较网格上实测过的点，不保证全局最优。</p>
      <Scatter sweep={latest} selected={selected?.index} onSelect={setChosen} />
      <p className="legend"><span className="dot ok" />通过全部检查 <span className="dot bad" />有未通过的检查 <span className="dot ring" />可行点中的帕累托前沿（更轻 / 壁厚余量更大）</p>
      {selected && <div className="sweep-pick" aria-live="polite">
        <strong>点 {selected.index} · {label(selected)}</strong>
        <span>{selected.mass} g · 最小壁厚 {minWall(selected)} mm · {selected.feasible ? <Chip tone="ok">全部通过</Chip> : <Chip tone="bad">未通过：{selected.failed.map(f => CAD_CHECK_LABELS[f] ?? f).join("、")}</Chip>}</span>
        {madeFrom(selected.index) ? <button type="button" className="secondary" onClick={() => c.navigate("validate", { kind: "cad-part", id: madeFrom(selected.index)!.id })}>查看已生成的候选 →</button>
          : <button type="button" disabled={c.busy} onClick={() => void choosePoint(c, latest, selected)}>以此参数生成正式候选</button>}
      </div>}
      <div className="table-wrap"><table className="sweep-table"><caption className="visually-hidden">扫描点（可行点在前，按质量升序）</caption>
        <thead><tr><th scope="col">#</th><th scope="col">t</th><th scope="col">W</th><th scope="col">H</th><th scope="col">Ø</th><th scope="col">质量 g</th><th scope="col">最小壁厚</th><th scope="col">结果</th></tr></thead>
        <tbody>{rows.map(p => <tr key={p.index} className={`${p.index === selected?.index ? "sel" : ""} ${p.feasible ? "" : "fail"}`} onClick={() => setChosen(p.index)}>
          <td><button type="button" className="link" onClick={() => setChosen(p.index)} aria-label={`选择点 ${p.index}`}>{p.index}</button></td>
          <td>{p.parameters.thickness}</td><td>{p.parameters.width}</td><td>{p.parameters.plateHeight}</td><td>{p.parameters.pilotBore}</td>
          <td>{p.mass ?? "—"}</td><td>{Number.isFinite(minWall(p)) ? minWall(p) : "—"}</td>
          <td>{p.feasible ? "✓" : p.error ? "建模失败" : p.failed.map(f => CAD_CHECK_LABELS[f] ?? f).join("、")}{(latest.pareto ?? []).includes(p.index) ? " · 前沿" : ""}</td></tr>)}</tbody></table></div>
    </>}
  </Card>;
}
