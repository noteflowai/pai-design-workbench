import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { AppContext, VIEWS, type Ctx, type Route, type State, type ViewId } from "./context";
import { Toasts } from "./ui";
import { Assistant, useLiveSession } from "./studio";
import { Palette, type Command } from "./palette";
import { Overview } from "./views/overview";
import { Requirements } from "./views/requirements";
import { Design } from "./views/design";
import { Validate } from "./views/validate";
import { Evidence } from "./views/evidence";
import { FeedbackView } from "./views/feedback";
import { Deliver } from "./views/deliver";
import { runScene } from "./actions";
import "./style.css";

function parseRoute(): Route {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const view = (VIEWS.some(v => v.id === path) ? path : "overview") as ViewId;
  return { view, params: new URLSearchParams(query) };
}
const DOT: Record<string, string> = { done: "完成", attention: "需处理", active: "运行中", pending: "未开始" };

function App() {
  const [data, setData] = useState<State>();
  const [loadError, setLoadError] = useState("");
  const [projectId, setProjectId] = useState(() => localStorage.getItem("pai-project") ?? "");
  const [route, setRoute] = useState<Route>(parseRoute);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; message: string; tone: "ok" | "bad" }[]>([]);
  // Docked on wide screens; on phones it is a full-screen sheet that always starts closed.
  const [assistant, setAssistant] = useState(() => { if (innerWidth < 900) return false; const saved = localStorage.getItem("pai-assistant"); return saved ? saved === "open" : innerWidth >= 1200; });
  const { session, track } = useLiveSession();
  const seq = useRef(0), lastView = useRef(route.view);

  const refresh = useCallback(async () => { const s = await api<State>("/state"); setData(s); return s; }, []);
  useEffect(() => { void refresh().catch(e => setLoadError(String(e instanceof Error ? e.message : e))); }, [refresh]);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (lastView.current === route.view) return;
    lastView.current = route.view;
    scrollTo({ top: 0 });
    requestAnimationFrame(() => (document.querySelector("main h1") as HTMLElement | null)?.focus({ preventScroll: true }));
  }, [route.view]);
  useEffect(() => {
    // Crossing into phone width turns the docked assistant into a closed sheet instead of covering the work area.
    const query = matchMedia("(max-width: 899px)");
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setAssistant(false); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => { if (innerWidth >= 900) localStorage.setItem("pai-assistant", assistant ? "open" : "closed"); }, [assistant]);

  const toast = useCallback((message: string, tone: "ok" | "bad" = "ok") => setToasts(t => [...t.filter(x => x.tone === "bad").slice(-1), { id: ++seq.current, message, tone }]), []);
  const dismiss = useCallback((id: number) => setToasts(t => t.filter(x => x.id !== id)), []);
  const navigate = useCallback((view: ViewId, params: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
    const hash = `#/${view}${q ? `?${q}` : ""}`;
    if (location.hash !== hash) location.hash = hash; else setRoute(parseRoute());
  }, []);
  const perform = useCallback(async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await action(); await refresh(); toast(message); return true; }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "bad"); await refresh().catch(() => undefined); return false; }
    finally { setBusy(false); }
  }, [refresh, toast]);
  const selectProject = useCallback((id: string) => { setProjectId(id); localStorage.setItem("pai-project", id); }, []);

  const project = data?.projects.find(p => p.id === projectId) ?? data?.projects.at(-1);
  const lifecycle = project ? data?.lifecycles?.[project.id] : undefined;
  const ctx: Ctx | undefined = data && { data, project, lifecycle, busy, route, navigate, perform, refresh, selectProject, toast, track, session,
    openAssistant: () => { setAssistant(true); setTimeout(() => dispatchEvent(new Event("pai-focus-chat")), 50); } };

  const commands: Command[] = useMemo(() => [
    { id: "assistant", label: "打开 AI 助手", hint: "/", run: () => { setAssistant(true); setTimeout(() => dispatchEvent(new Event("pai-focus-chat")), 50); } },
    ...VIEWS.map(v => ({ id: `go-${v.id}`, label: `前往：${v.index ? `${v.index} ` : ""}${v.label}`, run: () => navigate(v.id) })),
    { id: "new", label: "新建评审任务", run: () => navigate("requirements", { new: "1" }) },
    { id: "scene", label: "生成并检查 Blender 场景（默认参数）", run: () => { if (ctx?.project && data?.capabilities.blender) void runScene(ctx, "occluded", { maxFootprintArea: 12, targetEnvelopeRadius: 1.4, requireTargetVisible: true }); else navigate("design", { lane: "scene" }); } },
    { id: "cad", label: "CAD 零件：NEMA 17 电机支架", run: () => navigate("design", { lane: "cad" }) },
    { id: "factory", label: "工厂维护与能源评审", run: () => navigate("design", { lane: "factory" }) },
    ...(["persp", "top", "front", "right", "camera"] as const).map(v => ({ id: `view-${v}`, label: `视图：${{ persp: "透视", top: "顶视", front: "前视", right: "右视", camera: "检查相机" }[v]}`,
      hint: { persp: "5", top: "7", front: "1", right: "3", camera: "0" }[v], run: () => dispatchEvent(new CustomEvent("pai-view", { detail: v })) })),
    { id: "wire", label: "切换线框显示", hint: "Z", run: () => dispatchEvent(new CustomEvent("pai-view", { detail: "wire" })) },
    { id: "xray", label: "切换 X 光透视", hint: "Alt Z", run: () => dispatchEvent(new CustomEvent("pai-view", { detail: "xray" })) },
  ], [navigate, ctx, data?.capabilities.blender]);

  if (!ctx) return <div className="boot" role="status">{loadError ? `无法加载工作区：${loadError}` : "正在加载工作区…"}</div>;
  const view = { overview: <Overview />, requirements: <Requirements />, design: <Design />, validate: <Validate />, evidence: <Evidence />, feedback: <FeedbackView />, deliver: <Deliver /> }[route.view];
  return <AppContext.Provider value={ctx}>
    <a className="skip-link" href="#main" onClick={e => { e.preventDefault(); (document.querySelector("main h1") as HTMLElement | null)?.focus(); }}>跳到主要内容</a>
    <div className={`app ${assistant ? "with-assistant" : ""}`}>
      <header className="topbar">
        <a className="brand" href="#/overview" aria-label="PAI Design Workbench 总览"><span className="brand-mark">P</span><span>PAI<small>DESIGN WORKBENCH</small></span></a>
        <div className="project-switch">
          {ctx.data.projects.length > 0 && <select aria-label="选择已有任务" value={project?.id ?? ""} onChange={e => { selectProject(e.target.value); navigate("overview"); }}>
            {[...ctx.data.projects].reverse().map(p => <option key={p.id} value={p.id}>{p.title} · v{p.revision}</option>)}</select>}
          <button type="button" className="secondary compact" onClick={() => navigate("requirements", { new: "1" })}>新建</button>
        </div>
        <div className="top-actions">
          <button type="button" className="ghost command" onClick={() => dispatchEvent(new Event("pai-palette"))} aria-label="打开命令面板">命令 <kbd>Ctrl K</kbd></button>
          <button type="button" className={assistant ? "assistant-toggle on" : "assistant-toggle"} aria-pressed={assistant} onClick={() => setAssistant(a => !a)}>AI 助手</button>
          {ctx.data.capabilities.authenticatedWorkspace && <a className="session-logout" href="/logout">退出登录</a>}
        </div>
      </header>
      <nav className="rail" aria-label="生命周期">
        <ol>{VIEWS.map(v => { const stage = lifecycle?.stages.find(s => s.id === v.id); return <li key={v.id}>
          <a href={`#/${v.id}`} aria-current={route.view === v.id ? "page" : undefined} className={stage ? `s-${stage.status}` : "s-overview"}
            aria-label={`${v.index ? `${v.index} ` : ""}${v.label}${stage ? `：${DOT[stage.status]}，${stage.metric}` : ""}`}>
            <span className="rail-index" aria-hidden="true">{v.index ?? "◎"}</span>
            <span className="rail-text"><span className="rail-label">{v.label}</span><span className="rail-short" aria-hidden="true">{v.short}</span>{stage && <small>{stage.metric}</small>}</span>
            {stage && <span className="rail-dot" title={DOT[stage.status]} />}</a></li>; })}</ol>
        <p className="rail-foot">反馈 → 复测 → 验证 形成闭环<br />记录仿真 · 合成场景 · 演示孪生<br />尚未现场验证</p>
      </nav>
      <main id="main" aria-busy={busy}>{busy && <div className="busy" role="progressbar" aria-label="正在执行并保存回执" />}{view}</main>
      {assistant && <aside className="assistant" aria-label="AI 助手"><Assistant onClose={() => setAssistant(false)} /></aside>}
    </div>
    <Toasts items={toasts} dismiss={dismiss} />
    <Palette commands={commands} />
  </AppContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => { /* Installability is optional; never queue API commands offline. */ });
