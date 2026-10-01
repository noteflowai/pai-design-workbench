import { useEffect, useState } from "react";
import { api, requestIdFor } from "./api";
import { useApp } from "./context";
import { Check, Verdict } from "./ui";
import type { FactoryCriteria, FactoryCriteriaValues, FactoryReview } from "../src/factory";

export const CHECK_LABELS: Record<string, string> = {
  "output-per-seed": "单种子产出", "demand-intervals": "需量超限", "hall-comfort": "车间舒适度", "ev-service": "EV 充电服务",
  "closed-failures": "闭环故障", "net-output-gain": "面板净产出",
};
const FIELDS: { key: keyof FactoryCriteriaValues; label: string; step: number; min: number; max: number; scale?: number; unit: string }[] = [
  { key: "maxOutputLossPerSeed", label: "单种子最多损失良品", step: 1, min: 0, max: 50, unit: "件" },
  { key: "minEvServiceRatio", label: "EV 充电服务不低于", step: 1, min: 0, max: 100, scale: 100, unit: "%" },
  { key: "maxHallC", label: "车间温度不高于", step: 0.1, min: 10, max: 40, unit: "°C" },
  { key: "maxClosedIntervalsOverLimit", label: "需量超限区间不多于", step: 1, min: 0, max: 20, unit: "个" },
  { key: "maxClosedFailures", label: "闭环非计划故障不多于", step: 1, min: 0, max: 20, unit: "次" },
];
const FALLBACK: FactoryCriteriaValues = { maxOutputLossPerSeed: 0, maxClosedIntervalsOverLimit: 0, maxHallC: 25, minEvServiceRatio: 0.8, maxClosedFailures: 0, requireNetOutputGain: true };

export function FactoryCriteriaForm({ prefill, onFrozen }: { prefill?: FactoryCriteriaValues; onFrozen?: (c: FactoryCriteria) => void }) {
  const c = useApp();
  const defaults = c.data.capabilities.factoryTwin?.defaultCriteria ?? FALLBACK;
  const [values, setValues] = useState<FactoryCriteriaValues>(prefill ?? defaults);
  const [rationale, setRationale] = useState("在导入任何工厂孪生证据之前冻结：产出、EV 服务、舒适度与需量均为硬约束。");
  useEffect(() => { if (prefill) setValues(prefill); }, [prefill]);
  const p = c.project;
  return <form className="criteria-form" onSubmit={e => { e.preventDefault(); void c.perform(async () => {
    const record = await api<FactoryCriteria>(`/projects/${p!.id}/factory-criteria`, { requestId: requestIdFor(`pai-fc-${p!.id}-${p!.revision}-${JSON.stringify(values)}-${rationale}`),
      projectRevision: p!.revision, criteria: values, rationale });
    onFrozen?.(record);
  }, "工厂验收标准已冻结；之后导入的证据只能按此版本评估。"); }}>
    <div className="field-grid">{FIELDS.map(f => <label key={f.key}>{f.label}<span className="unit-input"><input type="number" step={f.step} min={f.min} max={f.max}
      value={f.scale ? Math.round((values[f.key] as number) * f.scale) : values[f.key] as number}
      onChange={e => setValues(v => ({ ...v, [f.key]: f.scale ? Number(e.target.value) / f.scale : Number(e.target.value) }))} /><em>{f.unit}</em></span></label>)}
      <label className="inline"><input type="checkbox" checked={values.requireNetOutputGain} onChange={e => setValues(v => ({ ...v, requireNetOutputGain: e.target.checked }))} />要求面板净产出增加（能耗不可抵消）</label></div>
    <label>冻结理由<textarea value={rationale} minLength={5} rows={2} onChange={e => setRationale(e.target.value)} /></label>
    <div className="form-foot"><small>标准记录带摘要哈希与时间；放宽只能新建版本，旧结论不变。</small><button type="submit" className="secondary" disabled={c.busy || !p}>冻结工厂验收标准</button></div>
  </form>;
}

function Bars({ review }: { review: FactoryReview }) {
  const w = 560, h = 190, pad = 28, seeds = review.seeds, max = Math.max(...seeds.map(s => Math.abs(s.goodUnitsGain)), 1);
  const bw = (w - pad * 2) / seeds.length, zero = h / 2, threshold = -review.criteria.maxOutputLossPerSeed;
  const y = (v: number) => zero - (v / max) * (h / 2 - 22);
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="每个种子的良品增减：闭环相对影子模式" className="chart">
    <line x1={pad} x2={w - pad} y1={zero} y2={zero} className="axis" />
    <line x1={pad} x2={w - pad} y1={y(threshold)} y2={y(threshold)} className="threshold" />
    <text x={pad + 2} y={y(threshold) + 12} className="threshold-label">允许下限 {threshold}</text>
    {seeds.map((s, i) => <g key={s.seed}><rect x={pad + i * bw + 4} width={bw - 8} y={Math.min(y(s.goodUnitsGain), zero)} height={Math.abs(y(s.goodUnitsGain) - zero)}
      className={s.checks["output-per-seed"] ? "bar ok" : "bar fail"}><title>seed {s.seed}: {s.goodUnitsGain}</title></rect>
      <text x={pad + i * bw + bw / 2} y={h - 4} textAnchor="middle">{s.seed}</text>
      <text x={pad + i * bw + bw / 2} y={s.goodUnitsGain >= 0 ? y(s.goodUnitsGain) - 4 : y(s.goodUnitsGain) + 12} textAnchor="middle" className="value">{s.goodUnitsGain}</text></g>)}
  </svg>;
}
function EvLine({ review }: { review: FactoryReview }) {
  const w = 560, h = 170, pad = 28, seeds = review.seeds, min = 0.5;
  const x = (i: number) => pad + (i + 0.5) * ((w - pad * 2) / seeds.length);
  const y = (v: number) => h - 22 - ((v - min) / (1 - min)) * (h - 44);
  const t = review.criteria.minEvServiceRatio;
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="每个种子的 EV 充电服务比例与冻结下限" className="chart">
    <line x1={pad} x2={w - pad} y1={y(1)} y2={y(1)} className="axis" />
    <line x1={pad} x2={w - pad} y1={y(t)} y2={y(t)} className="threshold" />
    <text x={pad + 2} y={y(t) + 12} className="threshold-label">冻结下限 {Math.round(t * 100)}%</text>
    <polyline className="line" points={seeds.map((s, i) => `${x(i)},${y(Math.max(min, s.evServiceRatio))}`).join(" ")} />
    {seeds.map((s, i) => <g key={s.seed}><circle cx={x(i)} cy={y(Math.max(min, s.evServiceRatio))} r={5} className={s.checks["ev-service"] ? "dot ok" : "dot fail"}><title>seed {s.seed}: {(s.evServiceRatio * 100).toFixed(1)}%</title></circle>
      <text x={x(i)} y={h - 4} textAnchor="middle">{s.seed}</text></g>)}
  </svg>;
}

function factoryDetail(review: FactoryReview, id: string): string {
  const k = review.criteria, f = review.aggregate.failingSeeds as Record<string, number[]>;
  const seeds = (x: string) => f[x]?.length ? `未满足的种子：${f[x].join("、")}` : "全部种子满足";
  return ({
    "output-per-seed": `单种子良品损失不超过 ${k.maxOutputLossPerSeed} 件；${seeds("output-per-seed")}`,
    "demand-intervals": `闭环需量超限区间不超过 ${k.maxClosedIntervalsOverLimit} 个；${seeds("demand-intervals")}`,
    "hall-comfort": `闭环车间最高温度不超过 ${k.maxHallC} °C；${seeds("hall-comfort")}`,
    "ev-service": `EV 充电量不低于影子计划的 ${Math.round(k.minEvServiceRatio * 100)}%；${seeds("ev-service")}`,
    "closed-failures": `闭环非计划故障不超过 ${k.maxClosedFailures} 次；${seeds("closed-failures")}`,
    "net-output-gain": `面板净良品 ${review.aggregate.netGoodUnitsGain > 0 ? "+" : ""}${review.aggregate.netGoodUnitsGain}${k.requireNetOutputGain ? "（要求 > 0）" : "（未要求）"}；能耗单独报告，不抵消产出`,
  } as Record<string, string>)[id] ?? id;
}
export function FactoryResult({ review }: { review: FactoryReview }) {
  return <>
    <Verdict tone={review.verdict === "rejected" ? "bad" : "ok"} eyebrow={`工厂孪生评审 · ${review.aggregate.pairs} 个配对种子 · 演示仿真`}
      title={review.verdict === "rejected" ? "维护方案拒绝" : "演示仿真范围内通过"}
      detail={`净良品 ${review.aggregate.netGoodUnitsGain > 0 ? "+" : ""}${review.aggregate.netGoodUnitsGain}；改善 ${review.aggregate.pairsImproved} 对、退化 ${review.aggregate.pairsWorse} 对；单位良品电耗平均变化 ${review.aggregate.meanImportIntensityChange} kWh（不抵消其他约束）。`} />
    <ul className="checks">{review.checks.map(x => <Check key={x.id} passed={x.passed} title={CHECK_LABELS[x.id]} detail={factoryDetail(review, x.id)} />)}</ul>
    <div className="charts"><figure><figcaption>良品增减（闭环 − 影子）</figcaption><Bars review={review} /></figure><figure><figcaption>EV 充电服务（闭环 / 影子计划）</figcaption><EvLine review={review} /></figure></div>
    <div className="table-wrap"><table className="seed-table"><caption className="visually-hidden">逐种子结果</caption>
      <thead><tr><th scope="col">种子</th><th scope="col">良品增减</th><th scope="col">EV 服务</th><th scope="col">车间最高</th><th scope="col">超限</th><th scope="col">故障</th><th scope="col">指令</th></tr></thead>
      <tbody>{review.seeds.map(s => <tr key={s.seed}><th scope="row">{s.seed}</th>
        <td className={s.checks["output-per-seed"] ? "" : "fail"}>{s.goodUnitsGain > 0 ? "+" : ""}{s.goodUnitsGain}</td>
        <td className={s.checks["ev-service"] ? "" : "fail"}>{(s.evServiceRatio * 100).toFixed(1)}%</td>
        <td className={s.checks["hall-comfort"] ? "" : "fail"}>{s.closedHallC.toFixed(2)} °C</td>
        <td className={s.checks["demand-intervals"] ? "" : "fail"}>{s.closedIntervalsOverLimit}</td>
        <td className={s.checks["closed-failures"] ? "" : "fail"}>{s.closedFailures}<small>影子 {s.shadowFailures}</small></td>
        <td>{s.commandsActuated}</td></tr>)}</tbody></table></div>
  </>;
}
