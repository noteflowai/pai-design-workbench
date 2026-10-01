import { CAD_CHECK_LABELS, CAD_VARIANTS, CANDIDATES, KIND_LABEL, useApp, type RunKind } from "../context";
import { Card, Chip, projectRuns, time, verdictOf } from "../ui";
import { CHECK_LABELS } from "../factory";

const SCENE: Record<string, string> = { "footprint-area": "静态占地", "declared-target-envelope": "声明的目标包络", "camera-visibility": "相机射线可见性" };
const ROBOT: Record<string, string> = { "minimum-recorded-success": "最低成功率", "preserve-baseline-success": "基准成功保留", "independent-improvement": "统计改善要求" };
type Column = { id: string; title: string; verdict: { label: string; tone: ReturnType<typeof verdictOf>["tone"] }; at: string; recheck: boolean;
  cells: Record<string, boolean | null>; metrics: [string, string][] };

/** Side-by-side check matrix across candidates of one evidence kind, like comparing versions in a PDM. */
export function CompareCandidates({ kind, selected }: { kind: RunKind; selected?: string }) {
  const c = useApp(), p = c.project!;
  const runs = projectRuns(c.data, p.id).filter(r => r.kind === kind && r.state === "completed").slice(0, 6);
  if (runs.length < 2) return null;
  let rows: [string, string][] = [];
  const columns: Column[] = runs.map(r => {
    const base = { id: r.id, verdict: verdictOf(r.kind, r.verdict, r.state), at: r.createdAt, recheck: r.recheck };
    if (kind === "cad-part") {
      const x = (c.data.cads ?? []).find(y => y.id === r.id)!;
      rows = Object.entries(CAD_CHECK_LABELS);
      return { ...base, title: CAD_VARIANTS[x.request.variant][0], cells: Object.fromEntries(x.candidate!.checks.map(k => [k.id, k.passed])),
        metrics: [["实测质量", `${x.candidate!.mass} g`], ["板厚", `${(x.candidate as unknown as { parameters: { thickness: number } }).parameters?.thickness ?? "—"} mm`]] };
    }
    if (kind === "blender-scene") {
      const x = c.data.scenes.find(y => y.id === r.id)!;
      rows = Object.entries(SCENE);
      return { ...base, title: x.request.variant === "occluded" ? "带遮挡" : "无遮挡", cells: Object.fromEntries(x.candidate!.checks.map(k => [k.id, k.passed])),
        metrics: [["占地上限", `${x.request.requirements.maxFootprintArea} m²`], ["首个命中", x.rays?.candidate?.firstHit ?? "—"]] };
    }
    if (kind === "factory-twin") {
      const x = (c.data.factoryReviews ?? []).find(y => y.id === r.id)!;
      rows = Object.entries(CHECK_LABELS);
      return { ...base, title: `标准 ${x.criteriaDigest.slice(0, 6)}`, cells: Object.fromEntries(x.checks.map(k => [k.id, k.passed])),
        metrics: [["净良品", `${x.aggregate.netGoodUnitsGain}`], ["EV ≥", `${Math.round(x.criteria.minEvServiceRatio * 100)}%`]] };
    }
    const x = c.data.reviews.find(y => y.id === r.id)!;
    rows = Object.entries(ROBOT);
    const cond = x.stress?.conditions.find(k => k.id === x.candidate);
    return { ...base, title: CANDIDATES[x.candidate], cells: Object.fromEntries((x.decision?.checks ?? []).map(k => [k.id, k.passed])),
      metrics: [["记录成功", `${cond?.successes ?? "—"}/${cond?.trials ?? "—"}`], ["丢失基准", `${x.diff?.blocking_changes ?? "—"}`]] };
  });
  const metricNames = columns[0].metrics.map(([k]) => k);
  return <Card title={`候选对比 · ${KIND_LABEL[kind]}`} aside={<small>最近 {columns.length} 次完成的检查</small>} id="compare">
    <div className="table-wrap"><table className="data-table compare"><caption className="visually-hidden">候选检查矩阵</caption>
      <thead><tr><th scope="col">检查项</th>{columns.map(col => <th key={col.id} scope="col" className={col.id === selected ? "sel" : ""}>
        <button type="button" className="link" onClick={() => c.navigate("validate", { kind, id: col.id })}>{col.title}</button>
        <small>{time(col.at)}{col.recheck ? " · 复测" : ""}</small></th>)}</tr></thead>
      <tbody>
        <tr><th scope="row">结论</th>{columns.map(col => <td key={col.id} className={col.id === selected ? "sel" : ""}><Chip tone={col.verdict.tone}>{col.verdict.label}</Chip></td>)}</tr>
        {rows.map(([id, label]) => <tr key={id}><th scope="row">{label}</th>{columns.map(col => { const v = col.cells[id];
          return <td key={col.id} className={`${v === false ? "fail" : ""} ${col.id === selected ? "sel" : ""}`}>{v === undefined ? "—" : v === null ? "未要求" : v ? "✓ 通过" : "× 未通过"}</td>; })}</tr>)}
        {metricNames.map((m, i) => <tr key={m}><th scope="row">{m}</th>{columns.map(col => <td key={col.id} className={col.id === selected ? "sel" : ""}>{col.metrics[i][1]}</td>)}</tr>)}
      </tbody></table></div>
  </Card>;
}
