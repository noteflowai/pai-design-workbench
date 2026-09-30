import { CANDIDATES, KIND_LABEL, useApp, type RunKind } from "../context";
import { Card, Chip, Empty, ViewHeader, projectRuns, time, verdictOf } from "../ui";
import { CaseList } from "./validate";
import type { CandidateId } from "../../src/contracts";

export function Evidence() {
  const c = useApp();
  const { project, route } = c;
  const runs = projectRuns(c.data, project?.id).filter(r => r.state === "completed");
  const id = route.params.get("id"), kind = route.params.get("kind") as RunKind | null;
  const run = runs.find(r => r.id === id) ?? runs.find(r => !kind || r.kind === kind) ?? runs[0];
  const header = <ViewHeader step="阶段 4 / 6 · 失败回放" title="证据与失败回放" description="直接查看绑定本次回执的原始证据：配对视频、原生场景文件与上游数据；内容摘要不匹配时拒绝提供。" />;
  if (!project || !run) return <>{header}<Empty title="还没有完成的检查" action={<button type="button" onClick={() => c.navigate("design")}>提交候选</button>}>完成原生验证后，这里提供回放、原生文件与回执。</Empty></>;
  return <>
    {header}
    <div className="toolbar"><label>证据记录<select aria-label="选择证据记录" value={run.id} onChange={e => { const r = runs.find(x => x.id === e.target.value)!; c.navigate("evidence", { kind: r.kind, id: r.id }); }}>
      {runs.map(r => <option key={r.id} value={r.id}>{KIND_LABEL[r.kind]} · {r.title} · {verdictOf(r.kind, r.verdict, r.state).label} · {time(r.createdAt)}</option>)}</select></label>
      <button type="button" className="secondary" onClick={() => c.navigate("validate", { kind: run.kind, id: run.id })}>查看结论</button></div>
    {run.kind === "robot-review" && <RobotEvidence id={run.id} />}
    {run.kind === "blender-scene" && <SceneEvidence id={run.id} />}
    {run.kind === "factory-twin" && <FactoryEvidence id={run.id} />}
    <CaseList runId={run.id} />
  </>;
}

function RobotEvidence({ id }: { id: string }) {
  const c = useApp();
  const run = c.data.reviews.find(r => r.id === id)!;
  const lost = (c.lifecycle?.failingCases ?? []).filter(x => x.runId === id).map(x => x.seed!);
  const seed = Number(c.route.params.get("seed") ?? lost[0] ?? 9);
  const other: CandidateId = run.candidate === "reference" ? "camera" : run.candidate;
  return <Card title="配对回放" aside={<label className="inline-select">种子<select aria-label="配对种子" value={seed} onChange={e => c.navigate("evidence", { kind: "robot-review", id, seed: e.target.value })}>
    {Array.from({ length: 10 }, (_, i) => <option key={i} value={i}>seed {i}{lost.includes(i) ? " · 失败案例" : ""}</option>)}</select></label>}>
    <div className="videos">{(["reference", other] as CandidateId[]).map(x => <figure key={`${id}-${x}-${seed}`}>
      <figcaption><strong>{CANDIDATES[x]}</strong><span>seed {seed} · 原始记录</span></figcaption>
      <video controls preload="metadata" playsInline src={`/api/runs/${id}/media/${x}/${seed}/main`} /></figure>)}</div>
    <p className="muted">视频内容 SHA-256 与本次核验的原始清单匹配；不同条件的录制长度可能不同。</p>
  </Card>;
}

function SceneEvidence({ id }: { id: string }) {
  const c = useApp();
  const scene = c.data.scenes.find(s => s.id === id)!;
  return <>
    <Card title="原生场景文件" aside={<small>下载前校验 SHA-256</small>}>
      <div className="scene-previews">{(["baseline", "candidate"] as const).map(w => <figure key={w}><img alt={`${w === "baseline" ? "基准" : "候选"}原生渲染`} src={`/api/scenes/${id}/files/${w}/preview.png`} /><figcaption>{w === "baseline" ? "基准布局" : "候选布局"}</figcaption></figure>)}</div>
      <div className="button-row">{([["scene.blend", "下载可编辑 .blend"], ["scene.glb", "下载 GLB"], ["checks.json", "下载原生检查"]] as const).map(([f, label]) =>
        <a key={f} className="button secondary" href={`/api/scenes/${id}/files/candidate/${f}`}>{label}</a>)}</div>
    </Card>
    <Card title="构建阶段与射线">
      <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">布局</th><th scope="col">阶段</th><th scope="col">对象</th><th scope="col">SHA-256</th></tr></thead>
        <tbody>{(["baseline", "candidate"] as const).flatMap(w => (scene.stages?.[w] ?? []).map(s => <tr key={`${w}-${s.index}`}><td>{w === "baseline" ? "基准" : "候选"}</td><td>{s.index}. {s.label}</td><td>{s.objects.join("、")}</td><td><code>{s.sha256.slice(0, 12)}</code></td></tr>))}</tbody></table></div>
      <p className="muted">原生射线首个命中：基准 {scene.rays?.baseline?.firstHit ?? "—"}；候选 {scene.rays?.candidate?.firstHit ?? "—"}。阶段文件是同一原生场景的展示快照。</p>
    </Card>
  </>;
}

function FactoryEvidence({ id }: { id: string }) {
  const c = useApp();
  const r = (c.data.factoryReviews ?? []).find(x => x.id === id)!;
  return <Card title="上游数据与一致性" aside={<Chip>{r.source.reviewedByWorkbench ? "已复核样本" : "上传 · 未复核"}</Chip>}>
    <dl className="kv">
      <div><dt>来源提交</dt><dd><code>{r.source.sourceCommit}</code></dd></div>
      <div><dt>seeds.json</dt><dd><code>{r.source.seedsSha256}</code></dd></div>
      <div><dt>manifest.json</dt><dd><code>{r.source.manifestSha256}</code></dd></div>
      <div><dt>冻结标准</dt><dd>{time(r.criteriaFrozenAt)} · <code>{r.criteriaDigest.slice(0, 16)}</code></dd></div>
    </dl>
    <ul className="plain">{r.consistency.map(x => <li key={x.id}>✓ {x.detail}</li>)}</ul>
    <details className="receipts"><summary>上游摘要（仅对照，不参与验收）</summary><pre>{JSON.stringify(r.upstreamSummary, null, 2)}</pre></details>
  </Card>;
}
