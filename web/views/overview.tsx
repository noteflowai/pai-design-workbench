import { useApp, VIEWS } from "../context";
import { Card, Chip, Empty, ViewHeader, time, type Tone } from "../ui";

const STATUS_TONE: Record<string, [string, Tone]> = { done: ["完成", "ok"], attention: ["需处理", "warn"], active: ["运行中", "live"], pending: ["未开始", "muted"] };

export function Overview() {
  const c = useApp();
  const { project, lifecycle: l } = c;
  if (!project || !l) return <>
    <ViewHeader step="项目总览" title="让设计决策有证据" description="从冻结需求到原生验证、失败回放、反馈复测和可核验交付，每一步都绑定证据。" />
    <Empty title="还没有评审任务" action={<button type="button" onClick={() => c.navigate("requirements", { new: "1" })}>新建评审任务</button>}>
      先冻结验收需求。之后可以在“候选设计”中提交机器人记录、Blender 场景或工厂孪生候选，或在 AI 助手中描述意图。</Empty>
  </>;
  const go = () => {
    const ref = l.next.ref;
    if (ref?.kind === "feedback") c.navigate("feedback", { id: ref.id });
    else if (ref && ["robot-review", "blender-scene", "factory-twin"].includes(ref.kind)) c.navigate(l.next.stage, { kind: ref.kind, id: ref.id });
    else c.navigate(l.next.stage);
  };
  return <>
    <ViewHeader step="项目总览" title={project.title} description={project.intendedDecision}
      actions={<><Chip tone="info">需求 v{project.revision}</Chip><Chip>SHA-256 {l.requirementDigest.slice(0, 10)}</Chip></>} />
    <section className="next-step" aria-label="下一步">
      <div><p className="eyebrow">下一步 · {VIEWS.find(v => v.id === l.next.stage)?.label}</p><h2>{l.next.label}</h2><p>{l.next.detail}</p></div>
      <button type="button" onClick={go}>前往 →</button>
    </section>
    <section className="loop" aria-label="全生命周期闭环">
      <ol>{l.stages.map(s => {
        const [label, tone] = STATUS_TONE[s.status];
        return <li key={s.id} className={`stage ${s.status}`}>
          <button type="button" onClick={() => c.navigate(s.id)} aria-label={`${s.index} ${s.label}：${label}，${s.metric}`}>
            <span className="stage-index">{s.index}</span><strong>{s.label}</strong><Chip tone={tone}>{label}</Chip>
            <span className="stage-metric">{s.metric}</span><small>{s.detail}</small></button></li>;
      })}</ol>
      <div className="loop-returns" aria-hidden="true"><span className="ret r1">反馈 → 新复测 → 原生验证</span><span className="ret r2">试用反馈 → 反馈复测</span></div>
    </section>
    <div className="split">
      <Card title="最近活动" aside={<small>{l.activity.length} 条</small>}>
        <ol className="activity">{l.activity.slice(0, 12).map((a, i) => <li key={i}>
          <time dateTime={a.at}>{time(a.at)}</time>
          <div><button type="button" className="link" onClick={() => a.ref?.kind === "feedback" ? c.navigate("feedback", { id: a.ref.id })
            : a.ref && ["robot-review", "blender-scene", "factory-twin"].includes(a.ref.kind) ? c.navigate("validate", { kind: a.ref.kind, id: a.ref.id }) : c.navigate(a.stage)}>{a.label}</button>
            {a.detail && <p>{a.detail}</p>}</div></li>)}</ol>
      </Card>
      <Card title="证据范围">
        <ul className="scope-list">
          <li><strong>机器人记录评审</strong>30 条真实历史记录、1 个任务、10 个配对种子；不执行新的策略推理。</li>
          <li><strong>Blender 场景</strong>合成静态几何的原生射线与投影检查；不代表关节可达性或动力学。</li>
          <li><strong>工厂孪生</strong>Robot Reel v0.18.0 演示仿真；参数未按真实工厂校准。</li>
          <li><strong>AI 助手</strong>只生成计划，没有验收或发布权；确认后才执行。</li>
        </ul>
        <p className="muted">尚未进行现场验证。独立试用者 {c.data.metrics.independentParticipants} 人（自报）；维护者与自动测试分开计量。</p>
      </Card>
    </div>
  </>;
}
