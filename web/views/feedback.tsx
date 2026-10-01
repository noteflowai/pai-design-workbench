import { useEffect, useState } from "react";
import { CAD_CHECK_LABELS, FEEDBACK_STATUS, useApp } from "../context";
import { Card, Chip, Empty, ViewHeader, time, type Tone } from "../ui";
import { advanceFeedback, defaultReason, feedbackAction, recordCaseFeedback } from "../actions";
import { CHECK_LABELS } from "../factory";
import type { Feedback } from "../../src/contracts";

const FLOW = ["received", "reproducible", "assigned", "fix-proposed", "rechecked", "closed"];
const tone = (s: string): Tone => s === "closed" ? "ok" : s === "rechecked" ? "info" : "warn";
const source = (f: Feedback) => f.evidenceKind === "blender-scene" ? `Blender · ${f.checkId}` : f.evidenceKind === "cad-part" ? `CAD · ${CAD_CHECK_LABELS[f.checkId ?? ""] ?? f.checkId}` : f.evidenceKind === "factory-twin"
  ? `工厂 · seed ${f.seed} · ${CHECK_LABELS[f.checkId ?? ""] ?? f.checkId}` : `机器人记录 · seed ${f.seed}`;
const HINT: Record<string, string> = {
  "fix-proposed": "将按处理方案重新执行原生检查，并把新回执绑定到此反馈；未修复时不能进入复测。",
  "no-change-with-reason": "将在原标准下重新评估；失败保持可见，只记录处置决定。",
  rechecked: "关闭前核对复测回执仍绑定当前需求版本。",
};

export function FeedbackView() {
  const c = useApp();
  const { project, route } = c;
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const items = c.data.feedback.filter(f => f.projectId === project?.id);
  const open = items.filter(f => f.status !== "closed"), closed = items.filter(f => f.status === "closed");
  const shown = filter === "open" ? open : filter === "closed" ? closed : items;
  const selected = items.find(f => f.id === route.params.get("id")) ?? shown[0] ?? items[0];
  const [reason, setReason] = useState("");
  const generated = Boolean(selected && selected.evidenceKind === "cad-part" && (c.data.cads ?? []).find(x => x.id === selected.runId)?.request.variant === "generated");
  useEffect(() => { if (selected) setReason(defaultReason(selected, generated)); }, [selected?.id, selected?.status, generated]);
  const header = <ViewHeader step="阶段 5 / 6 · 反馈复测" title="反馈复测" description="反馈必须绑定原始失败案例：复现 → 分配 → 处理方案 → 新的原生复测 → 关闭。失败记录不会被改写成通过。" />;
  const uncovered = (c.lifecycle?.failingCases ?? []).filter(x => !x.feedbackId);
  const pending = uncovered.length > 0 && <Card title="待记录反馈的失败案例" aside={<small>{uncovered.length} 个 · 记录后自动绑定证据</small>}>
    <ul className="cases">{uncovered.map(fc => <li key={`${fc.runId}-${fc.checkId ?? ""}-${fc.seed}`}><span className="case-label">{fc.label}</span>
      <span className="case-actions"><button type="button" className="secondary" onClick={() => c.navigate("evidence", { kind: fc.kind, id: fc.runId, ...(fc.seed !== null ? { seed: String(fc.seed) } : {}) })}>查看证据</button>
        <button type="button" disabled={c.busy} aria-label={`记录反馈：${fc.label}`} onClick={() => void recordCaseFeedback(c, fc)}>记录反馈</button></span></li>)}</ul></Card>;
  if (!project || items.length === 0) return <>{header}{pending || <Empty title="还没有反馈" action={<button type="button" onClick={() => c.navigate("design")}>提交候选</button>}>
    原生验证产生的失败案例会出现在这里，记录反馈后自动绑定证据与种子。</Empty>}</>;
  const run = selected && [...c.data.reviews, ...c.data.scenes, ...(c.data.cads ?? []), ...(c.data.factoryReviews ?? [])].find(r => r.id === selected.runId);
  const action = selected ? feedbackAction(selected, generated) : undefined;
  const stepIndex = selected ? Math.max(0, FLOW.indexOf(selected.status === "no-change-with-reason" ? "fix-proposed" : selected.status === "needs-context" ? "received" : selected.status)) : 0;
  return <>
    {header}
    <div className="toolbar"><div className="segmented" role="group" aria-label="筛选反馈">
      {([["open", `待处理 ${open.length}`], ["closed", `已关闭 ${closed.length}`], ["all", `全部 ${items.length}`]] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    {pending}
    <div className="master-detail">
      <nav className="run-list" aria-label="反馈列表">{shown.length === 0 && <p className="muted">没有{filter === "open" ? "待处理" : "已关闭"}的反馈。</p>}
        {shown.map(f => <button key={f.id} type="button" className={`run ${selected?.id === f.id ? "selected" : ""}`} aria-pressed={selected?.id === f.id} onClick={() => c.navigate("feedback", { id: f.id })}>
          <span className="run-kind">{source(f)}</span><strong>{f.observed}</strong><Chip tone={tone(f.status)}>{FEEDBACK_STATUS[f.status]}</Chip>
          <small>{time(f.history[0].at)} · {f.actorKind} · {f.id.slice(0, 8)}</small></button>)}</nav>
      {selected && <div className="detail">
        <Card title={source(selected)} aside={<Chip tone={tone(selected.status)}>{FEEDBACK_STATUS[selected.status]}</Chip>}>
          <ol className="progress" aria-label="反馈进度">{FLOW.map((s, i) => <li key={s} className={i < stepIndex ? "done" : i === stepIndex ? "current" : ""}>
            {s === "fix-proposed" && selected.status === "no-change-with-reason" ? "保留并说明" : FEEDBACK_STATUS[s]}</li>)}</ol>
          <dl className="kv">
            <div><dt>预期</dt><dd>{selected.expected}</dd></div><div><dt>观察</dt><dd>{selected.observed}</dd></div>
            <div><dt>绑定证据</dt><dd><button type="button" className="link" onClick={() => c.navigate("validate", { kind: selected.evidenceKind, id: selected.runId })}>
              {run ? `${selected.runId.slice(0, 8)} · 查看结论` : selected.runId.slice(0, 8)}</button></dd></div>
            <div><dt>来源</dt><dd>{selected.actorKind} · 版本 {selected.revision}</dd></div>
          </dl>
          {action ? <div className="stack">
            <label>处理与复测说明<textarea minLength={5} rows={2} value={reason} onChange={e => setReason(e.target.value)} /></label>
            {HINT[selected.status] && <p className="muted">{HINT[selected.status]}</p>}
            <div className="button-row end"><button type="button" disabled={c.busy || reason.trim().length < 5} onClick={() => void advanceFeedback(c, selected, reason)}>{action}</button></div>
          </div> : <p className="muted">已关闭。处理记录与复测回执保留，原失败案例不变。</p>}
        </Card>
        <Card title="处理记录"><ol className="activity">{[...selected.history].reverse().map((h, i) => <li key={i}><time dateTime={h.at}>{time(h.at)}</time>
          <div><strong>{FEEDBACK_STATUS[h.status]}</strong><p>{h.reason}</p>{h.recheckRunId && <button type="button" className="link" onClick={() => c.navigate("validate", { kind: selected.evidenceKind, id: h.recheckRunId })}>复测记录 {h.recheckRunId.slice(0, 8)} →</button>}</div></li>)}</ol></Card>
      </div>}
    </div>
  </>;
}
