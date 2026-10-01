import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, openLive, requestIdFor, type LiveEvent } from "./api";
import { useApp, type RunKind } from "./context";
import type { ViewportModel, Stage, Ray } from "./viewport";
import type { AssistantPlan, ToolPlan } from "../src/assistant";
import type { Project } from "../src/contracts";
import type { SceneReview } from "../src/scenes";
import type { CadReview } from "../src/cad";

type Which = "baseline" | "candidate";
type CadRequirementsLike = { maxMassG: number; minWallMm: number; edgeDistanceFactor: number };
export interface LiveSession {
  requestId: string; title: string; kind: RunKind; running: boolean; recordId?: string; verdict?: string; state?: string;
  steps: { id: string; label: string; status: string; detail?: string }[];
  stages: Record<Which, Stage[]>; rays: Partial<Record<Which, Ray>>; render: Partial<Record<Which, { sample: number; samples: number }>>; current?: Which;
}
export type LiveTrack = <T>(requestId: string, title: string, kind: RunKind, work: () => Promise<T>) => Promise<T>;

/** One live session at a time; the assistant and the stage views both feed it. Presentation only. */
export function useLiveSession() {
  const [session, setSession] = useState<LiveSession>();
  const track: LiveTrack = useCallback(async (requestId, title, kind, work) => {
    setSession({ requestId, title, kind, running: true, steps: [], stages: { baseline: [], candidate: [] }, rays: {}, render: {} });
    const apply = (e: LiveEvent) => setSession(s => {
      if (!s || s.requestId !== requestId) return s;
      const next = { ...s };
      if (e.kind === "step") {
        next.steps = [...s.steps.filter(x => x.id !== e.id), { id: e.id, label: e.label, status: e.status, detail: e.detail }];
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

export function viewportModel(session: LiveSession | undefined, scene: SceneReview | CadReview | undefined, which: Which,
  kind: "blender-scene" | "cad-part" = "blender-scene"): ViewportModel | undefined {
  const base = kind === "cad-part" ? "/api/cad" : "/api/scenes", finalFile = kind === "cad-part" ? "assembly.glb" : "scene.glb", units = kind === "cad-part" ? "mm" as const : "m" as const;
  const rays = (r?: SceneReview | CadReview) => (r as SceneReview | undefined)?.rays;
  const live = session?.kind === kind && (session.running || session.recordId === scene?.id || !scene) ? session : undefined;
  if (live && (live.stages.baseline.length || live.stages.candidate.length || live.running)) {
    const w = live.running ? live.current ?? "baseline" : which;
    const finalScene = !live.running && scene?.id === live.recordId && scene?.state === "completed" ? scene : undefined;
    return { key: live.requestId, which: w, stages: live.stages[w], ray: live.rays[w] ?? rays(finalScene)?.[w], render: live.render[w], units,
      running: live.running, title: live.title, finalUrl: finalScene ? `${base}/${finalScene.id}/files/${w}/${finalFile}` : undefined };
  }
  if (!scene) return undefined;
  const stages = (scene.stages?.[which] ?? []).map(s => ({ index: s.index, label: s.label, objects: s.objects, url: `${base}/${scene.id}/stages/${which}/${s.index}` }));
  return { key: scene.id, which, stages, ray: rays(scene)?.[which], running: scene.state === "running", units,
    title: `${kind === "cad-part" ? "零件" : "场景"} ${scene.id.slice(0, 8)}`,
    finalUrl: scene.state === "completed" ? `${base}/${scene.id}/files/${which}/${finalFile}` : undefined };
}

export function LiveSteps({ session }: { session: LiveSession }) {
  return <div className="live-steps" aria-label="实时工具步骤">
    <p><span className={`live-dot ${session.running ? "on" : ""}`} />{session.running ? "正在执行" : "最近执行"} · {session.title}</p>
    <ol>{session.steps.map(s => <li key={s.id} className={s.status}><span aria-hidden="true">{s.status === "done" ? "✓" : s.status === "failed" ? "×" : "◌"}</span>{s.label}{s.detail && <small>{s.detail}</small>}</li>)}</ol>
    {!session.running && <small>{session.state === "completed" ? `完成 · ${session.verdict ?? "已保存"}` : `状态：${session.state}`}；实时事件仅用于展示，结论以保存的记录为准。</small>}
  </div>;
}

const toolLabel: Record<string, string> = { "cad-review": "CadQuery", "create-project": "任务", "update-requirements": "需求修订", "scene-review": "Blender", "robot-review": "Robot Reel",
  "factory-criteria": "冻结标准", "factory-review": "工厂孪生", "model-proposal": "受控模型" };
const directionLabel: Record<string, string> = { new: "新", same: "不变", tightened: "收紧", relaxed: "放宽", changed: "变更" };
const recordKind: Record<string, string> = { "cad-review": "cad-review", "create-project": "project", "update-requirements": "project", "scene-review": "scene-review", "robot-review": "review",
  "factory-criteria": "factory-criteria", "factory-review": "factory-review", "model-proposal": "proposal" };
const nativeKind: Record<string, RunKind> = { "cad-review": "cad-part", "scene-review": "blender-scene", "robot-review": "robot-review", "factory-review": "factory-twin" };
const SUGGESTIONS = [
  "生成带遮挡的 Blender 工作单元，占地不超过 12 平方米，包络半径 1.4 m",
  "评审工厂维护与能源方案：产出不能下降，EV 充电不低于 80%，车间不超过 25 °C",
  "评估 NEMA 17 电机支架轻量化方案：壁厚不低于 3 mm，质量不超过 80 g",
  "验证相机偏移的 SmolVLA 记录评审",
];

/** Docked AI assistant: intent → typed plan → human confirmation → same native routes as the forms. */
export function Assistant({ onClose }: { onClose: () => void }) {
  const c = useApp();
  const { project, session } = c;
  const plans = (c.data.assistantPlans ?? []).filter(p => !project || !p.projectId || p.projectId === project.id).slice(-8);
  const [message, setMessage] = useState("");
  const [thinking, setThinking] = useState(false);
  const [running, setRunning] = useState<string>();
  const timeline = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: "smooth" }); }, [plans.length, session?.steps.length, running]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener("pai-focus-chat", focus);
    return () => window.removeEventListener("pai-focus-chat", focus);
  }, []);

  async function send(e?: FormEvent, text = message) {
    e?.preventDefault();
    if (!text.trim()) return;
    setThinking(true);
    try { await api<AssistantPlan>("/assistant/plans", { requestId: crypto.randomUUID(), projectId: project?.id, message: text.trim() }); setMessage(""); await c.refresh(); }
    catch (error) { c.toast(error instanceof Error ? error.message : String(error), "bad"); } finally { setThinking(false); }
  }

  async function execute(plan: AssistantPlan, step: ToolPlan) {
    setRunning(`${plan.id}:${step.id}`);
    try {
      const resolved: Record<string, string> = {};
      for (const x of plan.confirmations) resolved[x.planId] = x.recordId;
      if (step.dependsOn && !resolved[step.dependsOn]) throw new Error(`请先确认前置计划 ${step.dependsOn}`);
      let projectId = project?.id, revision = project?.revision;
      const projectStep = plan.plans.find(p => ["create-project", "update-requirements"].includes(p.tool));
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
      const run = () => api<{ id: string; state?: string }>(route, body, step.method);
      const kind = nativeKind[step.tool];
      if (kind) { c.navigate("validate", { kind }); if (window.innerWidth < 1024) onClose(); }
      const record = kind ? await c.track(body.requestId, step.title, kind, run) : await run();
      await api(`/assistant/plans/${plan.id}/confirmations`, { planId: step.id, recordKind: recordKind[step.tool], recordId: record.id });
      if (step.tool === "create-project") { c.selectProject(record.id); c.navigate("overview"); }
      if (kind) c.navigate("validate", { kind, id: record.id });
      if (record.state && !["completed", "done"].includes(record.state) && step.tool !== "model-proposal") throw new Error(`原生任务状态：${record.state}`);
      await c.refresh();
      c.toast(`已执行：${step.title}`);
    } catch (error) { c.toast(error instanceof Error ? error.message : String(error), "bad"); await c.refresh(); }
    finally { setRunning(undefined); }
  }

  return <div className="assistant-inner" id="studio">
    <div className="assistant-head"><div><strong>AI 助手</strong><small>意图 → 类型化计划 → 你确认 → 原生执行</small></div>
      <button type="button" className="ghost" aria-label="关闭 AI 助手" onClick={onClose}>×</button></div>
    <div className="chat-timeline" ref={timeline} aria-live="polite">
      {plans.length === 0 && <div className="chat-empty"><p>用专业语言描述设计意图。助手把对话解析为可审查的计划，显示每项约束的收紧或放宽；只有你确认后才调用原生工具。它没有验收权。</p>
        <div className="suggestions">{SUGGESTIONS.map(s => <button key={s} type="button" className="suggestion" onClick={() => void send(undefined, s)}>{s}</button>)}</div></div>}
      {plans.map(plan => <div key={plan.id} className="turn">
        <div className="bubble user">{plan.message}</div>
        <div className="bubble assistant">
          <div className="meta"><span className="chip muted">{plan.model.used ? "受控模型" : "确定性解析 · 无模型调用"}</span><span className="chip muted">权限：无</span></div>
          {plan.interpretation.map((line, i) => <p key={i}>{line}</p>)}
          {plan.plans.map(step => {
            const done = plan.confirmations.find(x => x.planId === step.id), key = `${plan.id}:${step.id}`;
            const changed = step.changes.filter(x => x.direction !== "same");
            return <article key={step.id} className={`plan-card ${done ? "done" : ""}`} aria-label={`计划 ${step.title}`}>
              <header><span className="tool-tag">{toolLabel[step.tool]}</span><strong>{step.title}</strong>{step.dependsOn && <small>依赖 {step.dependsOn}</small>}</header>
              {changed.length > 0 && <ul className="changes">{changed.map(x => <li key={x.field} className={x.direction}><span>{x.field}</span>
                <code>{x.from === null ? "—" : String(x.from)} → {String(x.to)}</code><em>{directionLabel[x.direction]}</em></li>)}</ul>}
              {step.warnings.map(w => <p key={w} className="warning">⚠ {w}</p>)}
              <details><summary>证据与参数</summary><p className="evidence">{step.evidence}</p><pre>{JSON.stringify({ route: `${step.method} /api${step.route}`, payload: step.payload }, null, 2)}</pre></details>
              <div className="plan-actions">
                {done ? <span className="confirmed">✓ 已执行 · {done.match === "as-proposed" ? "与计划一致" : "执行前经过修改"} · {done.recordId.slice(0, 8)}</span>
                  : <button type="button" disabled={c.busy || running !== undefined} onClick={() => void execute(plan, step)}>{running === key ? "执行中…" : "确认执行"}</button>}
                {!done && step.tool === "scene-review" && <button type="button" className="secondary" onClick={() => {
                  const r = step.payload.requirements as { maxFootprintArea: number; targetEnvelopeRadius: number; requireTargetVisible: boolean };
                  c.navigate("design", { lane: "scene", variant: String(step.payload.variant), area: String(r.maxFootprintArea), radius: String(r.targetEnvelopeRadius), visible: String(r.requireTargetVisible) });
                }}>在专业面板调整</button>}
                {!done && step.tool === "cad-review" && <button type="button" className="secondary" onClick={() => {
                  const r = step.payload.requirements as CadRequirementsLike;
                  c.navigate("design", { lane: "cad", variant: String(step.payload.variant), mass: String(r.maxMassG), wall: String(r.minWallMm), edge: String(r.edgeDistanceFactor) });
                }}>在专业面板调整</button>}
                {!done && step.tool === "factory-criteria" && <button type="button" className="secondary" onClick={() =>
                  c.navigate("requirements", { criteria: JSON.stringify(step.payload.criteria) })}>在专业面板调整</button>}
              </div>
            </article>;
          })}
        </div>
      </div>)}
      {session && (session.running || session.steps.length > 0) && <div className="bubble tool"><LiveSteps session={session} />
        {(session.kind === "blender-scene" || session.kind === "cad-part") && <button type="button" className="link" onClick={() => c.navigate("validate", { kind: session.kind, ...(session.recordId ? { id: session.recordId } : {}) })}>在三维视口查看 →</button>}</div>}
      {thinking && <div className="bubble assistant typing" aria-label="解析中"><i /><i /><i /></div>}
    </div>
    <form className="composer" onSubmit={e => void send(e)}>
      <label className="visually-hidden" htmlFor="studio-input">设计意图</label>
      <textarea id="studio-input" ref={input} rows={3} maxLength={2000} value={message} placeholder="描述意图，例如：生成带遮挡的工作单元，占地 ≤ 12 m²"
        onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} />
      <div className="composer-foot"><small>{c.data.capabilities.modelProposal ? "受控模型可作为计划步骤调用" : "未配置受控模型 · 不调用模型"} · Ctrl/⌘+Enter</small>
        <button type="submit" disabled={thinking || !message.trim()}>生成计划 ↵</button></div>
    </form>
  </div>;
}
