import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, openLive, requestIdFor, type LiveEvent } from "./api";
import type { ViewportModel, Stage, Ray } from "./viewport";
import type { AssistantPlan, ToolPlan } from "../src/assistant";
import type { Project } from "../src/contracts";
import type { SceneReview } from "../src/scenes";

const Viewport = lazy(() => import("./viewport"));
type Which = "baseline" | "candidate";
export interface LiveSession {
  requestId: string; title: string; running: boolean; recordId?: string; verdict?: string; state?: string;
  steps: { id: string; label: string; status: string; detail?: string }[];
  stages: Record<Which, Stage[]>; rays: Partial<Record<Which, Ray>>; render: Partial<Record<Which, { sample: number; samples: number }>>;
  current?: Which; scene: boolean;
}

/** One live session at a time; both the AI studio and the classic forms feed it. */
export function useLiveSession() {
  const [session, setSession] = useState<LiveSession>();
  const track = useCallback(async <T,>(requestId: string, title: string, scene: boolean, work: () => Promise<T>): Promise<T> => {
    setSession({ requestId, title, running: true, steps: [], stages: { baseline: [], candidate: [] }, rays: {}, render: {}, scene });
    const apply = (e: LiveEvent) => setSession(s => {
      if (!s || s.requestId !== requestId) return s;
      const next = { ...s };
      if (e.kind === "step") {
        const steps = s.steps.filter(x => x.id !== e.id);
        next.steps = [...steps, { id: e.id, label: e.label, status: e.status, detail: e.detail }];
        if (e.which === "baseline" || e.which === "candidate") next.current = e.which;
      } else if (e.kind === "record") next.recordId = e.recordId;
      else if (e.kind === "stage") { next.stages = { ...s.stages, [e.which]: [...s.stages[e.which].filter(x => x.index !== e.index), { index: e.index, label: e.label, url: e.url, objects: e.objects }] }; next.current = e.which; }
      else if (e.kind === "ray") next.rays = { ...s.rays, [e.which]: e };
      else if (e.kind === "render") next.render = { ...s.render, [e.which]: { sample: e.sample, samples: e.samples } };
      else if (e.kind === "done") Object.assign(next, { running: false, state: e.state, verdict: e.verdict, recordId: e.recordId ?? s.recordId });
      return next;
    });
    const close = await openLive(requestId, apply);
    try {
      const result = await work();
      const record = result as { id?: string; state?: string; verdict?: string; decision?: { verdict: string } };
      setSession(s => s && s.requestId === requestId ? { ...s, running: false, recordId: record.id ?? s.recordId, state: record.state ?? s.state ?? "completed",
        verdict: record.verdict ?? record.decision?.verdict ?? s.verdict } : s);
      return result;
    } catch (error) {
      setSession(s => s && s.requestId === requestId ? { ...s, running: false, state: "failed" } : s);
      throw error;
    } finally { setTimeout(close, 2_000); }
  }, []);
  return { session, track };
}

export function viewportModel(session: LiveSession | undefined, scene: SceneReview | undefined, which: Which): ViewportModel | undefined {
  const live = session?.scene && (session.running || session.recordId === scene?.id || !scene) ? session : undefined;
  if (live && (live.stages.baseline.length || live.stages.candidate.length || live.running)) {
    const w = live.running ? live.current ?? "baseline" : which;
    const finalScene = !live.running && scene?.id === live.recordId && scene?.state === "completed" ? scene : undefined;
    return { key: live.requestId, which: w, stages: live.stages[w], ray: live.rays[w] ?? finalScene?.rays?.[w], render: live.render[w],
      running: live.running, title: live.title, finalUrl: finalScene ? `/api/scenes/${finalScene.id}/files/${w}/scene.glb` : undefined };
  }
  if (!scene) return undefined;
  const stages = (scene.stages?.[which] ?? []).map(s => ({ index: s.index, label: s.label, objects: s.objects, url: `/api/scenes/${scene.id}/stages/${which}/${s.index}` }));
  return { key: scene.id, which, stages, ray: scene.rays?.[which], running: scene.state === "running", title: `场景 ${scene.id.slice(0, 8)} · ${scene.verdict ?? scene.state}`,
    finalUrl: scene.state === "completed" ? `/api/scenes/${scene.id}/files/${which}/scene.glb` : undefined };
}

const toolLabel: Record<string, string> = { "create-project": "任务", "update-requirements": "需求修订", "scene-review": "Blender", "robot-review": "Robot Reel",
  "factory-criteria": "冻结标准", "factory-review": "工厂孪生", "model-proposal": "受控模型" };
const directionLabel: Record<string, string> = { new: "新", same: "不变", tightened: "收紧", relaxed: "放宽", changed: "变更" };
const recordKind: Record<string, string> = { "create-project": "project", "update-requirements": "project", "scene-review": "scene-review", "robot-review": "review",
  "factory-criteria": "factory-criteria", "factory-review": "factory-review", "model-proposal": "proposal" };
const SUGGESTIONS = [
  "生成带遮挡的 Blender 工作单元，占地不超过 12 平方米，包络半径 1.4 m",
  "移除遮挡后重新生成场景并检查相机可见性",
  "评审工厂维护与能源方案：产出不能下降，EV 充电不低于 80%，车间不超过 25 °C",
  "验证相机偏移的 SmolVLA 记录评审",
];

export function Studio(props: {
  project?: Project; plans: AssistantPlan[]; modelConfigured: boolean; busy: boolean; session?: LiveSession; scene?: SceneReview;
  track: ReturnType<typeof useLiveSession>["track"]; refresh: () => Promise<unknown>; selectProject: (id: string) => void;
  onEditScene: (payload: Record<string, unknown>) => void; onEditFactory: (payload: Record<string, unknown>) => void; onError: (message: string) => void;
}) {
  const { project, plans, session } = props;
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const [running, setRunning] = useState<string>();
  const [results, setResults] = useState<Record<string, { recordId: string; summary: string }>>({});
  const [which, setWhich] = useState<Which>("candidate");
  const timeline = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const history = plans.filter(p => !project || !p.projectId || p.projectId === project.id).slice(-8);
  useEffect(() => { timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: "smooth" }); }, [history.length, session?.steps.length, running]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener("pai-focus-chat", focus);
    return () => window.removeEventListener("pai-focus-chat", focus);
  }, []);

  async function send(e?: FormEvent, text = message) {
    e?.preventDefault();
    if (!text.trim()) return;
    setThinking(true);
    try {
      await api<AssistantPlan>("/assistant/plans", { requestId: crypto.randomUUID(), projectId: project?.id, message: text.trim() });
      setMessage(""); await props.refresh();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); } finally { setThinking(false); }
  }

  async function execute(plan: AssistantPlan, step: ToolPlan) {
    setRunning(`${plan.id}:${step.id}`);
    try {
      const resolved: Record<string, string> = {};
      for (const c of plan.confirmations) resolved[c.planId] = c.recordId;
      let projectId = project?.id, revision = project?.revision;
      const projectStep = plan.plans.find(p => ["create-project", "update-requirements"].includes(p.tool));
      if (step.dependsOn && !resolved[step.dependsOn]) throw new Error(`请先确认前置计划 ${step.dependsOn}`);
      if (projectStep && resolved[projectStep.id] && step.id !== projectStep.id) {
        const state = await api<{ projects: Project[] }>("/state");
        const p = state.projects.find(x => x.id === resolved[projectStep.id]);
        if (p) { projectId = p.id; revision = p.revision; }
      }
      if (step.tool !== "create-project" && !projectId) throw new Error("需要先创建任务");
      const route = step.route.replace("{project}", projectId ?? "");
      const payload = JSON.parse(JSON.stringify(step.payload).replace(/"\{(p\d+)\}"/g, (_, id: string) => JSON.stringify(resolved[id] ?? "")));
      if ("projectRevision" in payload && revision) payload.projectRevision = revision;
      if (step.tool === "update-requirements") payload.expectedRevision = revision;
      const body = step.method === "POST" ? { ...payload, requestId: requestIdFor(`pai-plan-${plan.id}-${step.id}`) } : payload;
      const run = () => api<{ id: string; state?: string; verdict?: string; decision?: { verdict: string }; revision?: number }>(route, body, step.method);
      const native = ["scene-review", "robot-review", "factory-review"].includes(step.tool);
      const record = native ? await props.track(body.requestId, step.title, step.tool === "scene-review", run) : await run();
      await api(`/assistant/plans/${plan.id}/confirmations`, { planId: step.id, recordKind: recordKind[step.tool], recordId: record.id });
      if (step.tool === "create-project") props.selectProject(record.id);
      const verdict = record.verdict ?? record.decision?.verdict;
      setResults(r => ({ ...r, [`${plan.id}:${step.id}`]: { recordId: record.id, summary: verdict ? `结论：${verdict}` : record.state ? `状态：${record.state}` : "已保存" } }));
      if (record.state && !["completed", "done"].includes(record.state) && step.tool !== "model-proposal") throw new Error(`原生任务状态：${record.state}`);
      await props.refresh();
    } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); await props.refresh(); }
    finally { setRunning(undefined); }
  }

  const model = viewportModel(session, props.scene, session?.running ? session.current ?? which : which);
  const liveSteps = session?.steps ?? [];
  return <section id="studio" className="panel studio" aria-label="AI 设计工作室">
    <div className="section-top"><div><div className="eyebrow">00 / AI-NATIVE STUDIO</div><h2>对话驱动，原生工具执行</h2></div>
      <span className="pill">意图 → 类型化计划 → 确认 → 原生执行 → 独立检查</span></div>
    <div className="studio-grid">
      <div className="chat">
        <div className="chat-timeline" ref={timeline} aria-live="polite">
          {history.length === 0 && <div className="chat-empty"><strong>用专业语言描述设计意图</strong><p>助手把对话解析为可审查的工具计划：显示每项约束的收紧或放宽，确认后才调用 Blender、Robot Reel 或工厂孪生评审。它没有验收权。</p>
            <div className="suggestions">{SUGGESTIONS.map(s => <button key={s} type="button" className="secondary" onClick={() => void send(undefined, s)}>{s}</button>)}</div></div>}
          {history.map(plan => <div key={plan.id} className="turn">
            <div className="bubble user">{plan.message}</div>
            <div className="bubble assistant">
              <div className="assistant-meta"><span className="pill">{plan.model.used ? "受控模型" : "确定性解析 · 无模型调用"}</span><span className="pill">权限：无</span></div>
              {plan.interpretation.map((line, i) => <p key={i}>{line}</p>)}
              {plan.plans.map(step => {
                const done = plan.confirmations.find(c => c.planId === step.id);
                const key = `${plan.id}:${step.id}`, result = results[key];
                return <article key={step.id} className={`plan-card ${done ? "done" : ""}`} aria-label={`计划 ${step.title}`}>
                  <header><span className="tool-tag">{toolLabel[step.tool]}</span><strong>{step.title}</strong>{step.dependsOn && <small>依赖 {step.dependsOn}</small>}</header>
                  <p className="evidence">证据：{step.evidence}</p>
                  {step.changes.filter(c => c.direction !== "same").length > 0 && <ul className="changes">{step.changes.filter(c => c.direction !== "same").map(c =>
                    <li key={c.field} className={c.direction}><span>{c.field}</span><code>{c.from === null ? "—" : String(c.from)} → {String(c.to)}</code><em>{directionLabel[c.direction]}</em></li>)}</ul>}
                  {step.warnings.map(w => <p key={w} className="warning">⚠ {w}</p>)}
                  <details><summary>类型化参数</summary><pre>{JSON.stringify({ route: `${step.method} /api${step.route}`, payload: step.payload }, null, 2)}</pre></details>
                  <div className="plan-actions">
                    {done ? <span className="confirmed">✓ 已执行 · {done.match === "as-proposed" ? "与计划一致" : "执行前经过修改"} · {done.recordId.slice(0, 8)}</span>
                      : <button type="button" disabled={props.busy || running !== undefined} onClick={() => void execute(plan, step)}>{running === key ? "执行中…" : "确认执行"}</button>}
                    {!done && step.tool === "scene-review" && <button type="button" className="secondary" onClick={() => props.onEditScene(step.payload)}>在专业面板调整</button>}
                    {!done && step.tool === "factory-criteria" && <button type="button" className="secondary" onClick={() => props.onEditFactory(step.payload)}>在专业面板调整</button>}
                    {result && <small>{result.summary}</small>}
                  </div>
                </article>;
              })}
            </div>
          </div>)}
          {(liveSteps.length > 0 || session?.running) && <div className="bubble tool" aria-label="实时工具步骤">
            <strong>{session?.running ? "正在执行：" : "最近执行："}{session?.title}</strong>
            <ol className="steps">{liveSteps.map(s => <li key={s.id} className={s.status}><span>{s.status === "done" ? "✓" : s.status === "failed" ? "×" : "◌"}</span>{s.label}{s.detail && <small>{s.detail}</small>}</li>)}</ol>
            {session && !session.running && <p>{session.state === "completed" ? `完成 · ${session.verdict ?? "已保存"}` : `状态：${session.state}`}；实时事件仅用于展示，结论以保存的记录为准。</p>}
          </div>}
          {thinking && <div className="bubble assistant typing" aria-label="解析中"><i /><i /><i /></div>}
        </div>
        <form className="composer" onSubmit={e => void send(e)}>
          <label className="visually-hidden" htmlFor="studio-input">设计意图</label>
          <textarea id="studio-input" ref={input} rows={2} maxLength={2000} value={message} placeholder="例如：生成带遮挡的工作单元，占地 ≤ 12 m²；或 工厂评审，EV 充电 ≥ 80%"
            onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
          <button type="submit" disabled={thinking || !message.trim()}>生成计划 ↵</button>
        </form>
        <p className="muted">Ctrl/⌘+Enter 发送 · Ctrl/⌘+K 命令面板。{props.modelConfigured ? "受控模型可作为计划步骤调用。" : "受控模型未配置；对话解析为确定性规则，不调用模型。"}</p>
      </div>
      <div className="stage-view">
        <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={model} /></Suspense>
        <div className="which-toggle" role="group" aria-label="布局">
          {(["baseline", "candidate"] as const).map(w => <button key={w} type="button" className={which === w ? "active" : "secondary"} aria-pressed={which === w} onClick={() => setWhich(w)}>{w === "baseline" ? "基准布局" : "候选布局"}</button>)}
        </div>
      </div>
    </div>
  </section>;
}
