import { useEffect, useState } from "react";
import { api, requestIdFor } from "./api";
import type { useLiveSession } from "./studio";
import type { FactoryCriteria, FactoryCriteriaValues, FactoryReview } from "../src/factory";
import type { Project } from "../src/contracts";

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

function Bars({ review }: { review: FactoryReview }) {
  const w = 560, h = 190, pad = 28, seeds = review.seeds, max = Math.max(...seeds.map(s => Math.abs(s.goodUnitsGain)), 1);
  const bw = (w - pad * 2) / seeds.length, zero = h / 2, threshold = -review.criteria.maxOutputLossPerSeed;
  const y = (v: number) => zero - (v / max) * (h / 2 - 22);
  return <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="每个种子的良品增减：闭环相对影子模式" className="chart">
    <line x1={pad} x2={w - pad} y1={zero} y2={zero} className="axis" />
    <line x1={pad} x2={w - pad} y1={y(threshold)} y2={y(threshold)} className="threshold" />
    <text x={pad + 2} y={y(threshold) + 12} textAnchor="start" className="threshold-label">允许下限 {threshold}</text>
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
    <text x={pad + 2} y={y(t) + 12} textAnchor="start" className="threshold-label">冻结下限 {Math.round(t * 100)}%</text>
    <polyline className="line" points={seeds.map((s, i) => `${x(i)},${y(Math.max(min, s.evServiceRatio))}`).join(" ")} />
    {seeds.map((s, i) => <g key={s.seed}><circle cx={x(i)} cy={y(Math.max(min, s.evServiceRatio))} r={5} className={s.checks["ev-service"] ? "dot ok" : "dot fail"}><title>seed {s.seed}: {(s.evServiceRatio * 100).toFixed(1)}%</title></circle>
      <text x={x(i)} y={h - 4} textAnchor="middle">{s.seed}</text></g>)}
  </svg>;
}

export function FactoryPanel(props: {
  project?: Project; criteria: FactoryCriteria[]; reviews: FactoryReview[]; defaults: FactoryCriteriaValues; busy: boolean;
  prefill?: Record<string, unknown>; track: ReturnType<typeof useLiveSession>["track"];
  perform: (action: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const { project } = props;
  const [values, setValues] = useState<FactoryCriteriaValues>(props.defaults);
  const [rationale, setRationale] = useState("在导入任何工厂孪生证据之前冻结：产出、EV 服务、舒适度与需量均为硬约束。");
  const [criteriaId, setCriteriaId] = useState("");
  const [reviewId, setReviewId] = useState("");
  useEffect(() => { if (props.prefill?.criteria) { setValues(props.prefill.criteria as FactoryCriteriaValues); if (typeof props.prefill.rationale === "string") setRationale(props.prefill.rationale); } }, [props.prefill]);
  const criteria = props.criteria.filter(c => c.projectId === project?.id && c.projectRevision === project?.revision);
  const selected = criteria.find(c => c.id === criteriaId) ?? criteria.at(-1);
  const reviews = props.reviews.filter(r => r.projectId === project?.id);
  const review = reviews.find(r => r.id === reviewId) ?? reviews.at(-1);
  const freeze = () => props.perform(async () => {
    const record = await api<FactoryCriteria>(`/projects/${project!.id}/factory-criteria`, { requestId: requestIdFor(`pai-fc-${project!.id}-${project!.revision}-${JSON.stringify(values)}-${rationale}`),
      projectRevision: project!.revision, criteria: values, rationale });
    setCriteriaId(record.id);
  }, "工厂验收标准已冻结；之后导入的证据只能按此版本评估。");
  const evaluate = () => props.perform(async () => {
    const requestId = requestIdFor(`pai-fr-${project!.id}-${selected!.id}`);
    const record = await props.track(requestId, "工厂孪生逐种子评估", false, () => api<FactoryReview>(`/projects/${project!.id}/factory-reviews`,
      { requestId, projectRevision: project!.revision, criteriaId: selected!.id, source: { kind: "reviewed-sample", sampleId: "robot-reel-v0.18.0-b3ee5c7" } }));
    setReviewId(record.id);
  }, "已按冻结标准评估全部 12 个配对种子。");
  const failing = review ? Object.entries(review.aggregate.failingSeeds).flatMap(([check, seeds]) => seeds.map(seed => ({ check, seed }))) : [];
  return <section id="factory" className="panel">
    <div className="section-top"><div><div className="eyebrow">07 / FACTORY TWIN REVIEW</div><h2>维护与能源方案评审</h2></div><span className="pill">演示仿真 · 未按真实工厂校准</span></div>
    <p className="muted">Robot Reel v0.18.0 Factory Twin：六工位产线、AMR、车间温控与能源，同扰动下的 closed / shadow 配对。先冻结标准，再导入逐字节复核的 seeds.json 与 manifest.json；上游摘要与自检不参与验收。</p>
    <div className="factory-form">{FIELDS.map(f => <label key={f.key}>{f.label}（{f.unit}）<input type="number" step={f.step} min={f.min} max={f.max}
      value={f.scale ? Math.round((values[f.key] as number) * f.scale) : values[f.key] as number}
      onChange={e => setValues(v => ({ ...v, [f.key]: f.scale ? Number(e.target.value) / f.scale : Number(e.target.value) }))} /></label>)}
      <label className="check"><input type="checkbox" checked={values.requireNetOutputGain} onChange={e => setValues(v => ({ ...v, requireNetOutputGain: e.target.checked }))} />要求面板净产出增加（能源不可抵消）</label></div>
    <label>冻结理由<textarea value={rationale} minLength={5} onChange={e => setRationale(e.target.value)} /></label>
    <div className="form-footer"><p>标准记录带摘要哈希与时间；放宽只能新建版本，旧结论不变。</p>
      <div className="button-row"><button type="button" className="secondary" disabled={props.busy || !project} onClick={() => void freeze()}>冻结工厂验收标准</button>
        <button type="button" disabled={props.busy || !project || !selected} onClick={() => void evaluate()}>导入已复核样本并评估</button></div></div>
    {criteria.length > 0 && <label className="project-select">标准版本<select aria-label="选择工厂标准版本" value={selected?.id ?? ""} onChange={e => setCriteriaId(e.target.value)}>{criteria.map(c =>
      <option key={c.id} value={c.id}>{c.createdAt.slice(11, 19)} · 损失≤{c.criteria.maxOutputLossPerSeed} · EV≥{Math.round(c.criteria.minEvServiceRatio * 100)}% · {c.digest.slice(0, 8)}</option>)}</select></label>}
    {reviews.length > 0 && <label className="project-select">评估记录<select aria-label="选择工厂评估记录" value={review?.id ?? ""} onChange={e => setReviewId(e.target.value)}>{reviews.map(r =>
      <option key={r.id} value={r.id}>{r.verdict === "rejected" ? "拒绝" : "演示范围内通过"} · 标准 {r.criteriaDigest.slice(0, 8)} · {r.id.slice(0, 8)}</option>)}</select></label>}
    {review && <>
      <div className={`decision ${review.verdict === "rejected" ? "rejected" : ""}`}><div><span>工厂孪生评审 · {review.aggregate.pairs} 个配对种子</span>
        <h3>{review.verdict === "rejected" ? "维护方案拒绝" : "演示仿真范围内通过"}</h3>
        <p>净良品 {review.aggregate.netGoodUnitsGain > 0 ? "+" : ""}{review.aggregate.netGoodUnitsGain}；改善 {review.aggregate.pairsImproved} 对、退化 {review.aggregate.pairsWorse} 对；单位良品电耗平均变化 {review.aggregate.meanImportIntensityChange} kWh（不抵消其他约束）。</p></div>
        <span className="decision-symbol">{review.verdict === "rejected" ? "!" : "✓"}</span></div>
      <div className="check-list">{review.checks.map(c => <div key={c.id}><span className={`check-icon ${!c.passed ? "fail" : ""}`}>{c.passed ? "✓" : "×"}</span><div><strong>{CHECK_LABELS[c.id]}</strong><p>{c.detail}</p></div></div>)}</div>
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
      <div className="artifact-links">
        {failing.slice(0, 4).map(f => <button key={`${f.check}-${f.seed}`} type="button" className="secondary" disabled={props.busy} onClick={() => void props.perform(() => api("/feedback", {
          runId: review.id, evidenceKind: "factory-twin", kind: "design-check", checkId: f.check, seed: f.seed,
          expected: `seed ${f.seed} 满足冻结标准：${CHECK_LABELS[f.check]}`, observed: `seed ${f.seed} 未满足 ${CHECK_LABELS[f.check]}；保留失败并等待上游重跑或说明`, actorKind: "maintainer" }), "工厂反馈已绑定失败种子与冻结标准。")}>记录 seed {f.seed} · {CHECK_LABELS[f.check]}反馈</button>)}
        <button type="button" className="secondary" disabled={props.busy} onClick={() => void props.perform(() => api("/campaigns", { runId: review.id, evidenceKind: "factory-twin", channel: "direct-pilot" }), "工厂评审案例草稿已生成，尚未发送。")}>生成工厂案例草稿</button>
      </div>
      <details><summary>来源、一致性与冻结标准</summary><pre>{JSON.stringify({ source: review.source, consistency: review.consistency, criteria: review.criteria,
        criteriaFrozenAt: review.criteriaFrozenAt, criteriaDigest: review.criteriaDigest, upstreamSummary: review.upstreamSummary }, null, 2)}</pre></details>
    </>}
  </section>;
}
