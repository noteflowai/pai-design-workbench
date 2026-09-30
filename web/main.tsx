import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Campaign, Feedback, Project, Review, CandidateId } from "../src/contracts";
import type { Proposal } from "../src/proposals";
import type { SceneReview } from "../src/scenes";
import "./style.css";

type State = { projects: Project[]; reviews: Review[]; feedback: Feedback[]; campaigns: Campaign[];
  proposals: Proposal[]; scenes: SceneReview[]; metrics: { independentParticipants: number; independentEvents: number; independentRepeatUsers: number; maintainerEvents: number; fixtureEvents: number };
  capabilities: { modelProposal: boolean; blender: boolean; authenticatedWorkspace?: boolean } };
async function api<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  let r = await fetch(`/api${path}`, body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data = await r.json();
  const deadline = Date.now() + 360_000;
  while (r.status === 202) {
    const location = r.headers.get("Location");
    if (!location || !/^\/api\/(runs|scenes)\/[a-f0-9-]+$/.test(location)) throw new Error("检查任务未提供可核验状态地址");
    if (Date.now() >= deadline) throw new Error("检查仍在运行；请刷新查看原请求回执。不要以新请求重复执行。");
    await new Promise(resolve => setTimeout(resolve, 2_000));
    r = await fetch(location);
    data = await r.json();
  }
  if (!r.ok) throw new Error(`${data.error}: ${data.message ?? "请求被拒绝"}`);
  return data as T;
}
const labels: Record<string, string> = {
  reference: "基准设置", camera: "相机偏移", dim: "弱光设置",
  "accepted-in-recorded-panel": "记录样本内通过", rejected: "拒绝采用", "needs-more-evidence": "需要更多证据",
  received: "已收到", "needs-context": "待补充", reproducible: "已复现", assigned: "已分配",
  "fix-proposed": "方案已提出", "no-change-with-reason": "保留并说明", rechecked: "已复测", closed: "已关闭",
};
function App() {
  const [data, setData] = useState<State>();
  const [projectId, setProjectId] = useState("");
  const [runId, setRunId] = useState("");
  const [candidate, setCandidate] = useState<CandidateId>("camera");
  const [seed, setSeed] = useState(9);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [title, setTitle] = useState("SmolVLA 相机布局设计评审");
  const [intendedDecision, setIntended] = useState("判断相机偏移是否可以保留基准成功样本，并定位需回退的失败案例。");
  const [minRate, setMinRate] = useState(0.5);
  const [preserve, setPreserve] = useState(true);
  const [significant, setSignificant] = useState(false);
  const [expected, setExpected] = useState("保留基准设置在 seed 9 的成功结果");
  const [observed, setObserved] = useState("相机偏移后 seed 9 失败，需要回退并复测");
  const [reason, setReason] = useState("复现 seed 9 的回归；回退到基准设置并重新执行原生检查。");
  const [actor, setActor] = useState<"maintainer" | "independent" | "fixture">("maintainer");
  const [participant, setParticipant] = useState("local-maintainer");
  const [eventKind, setEventKind] = useState("started");
  const [verified, setVerified] = useState("");
  const [sceneVariant, setSceneVariant] = useState<"clear" | "occluded">("occluded");
  const [sceneId, setSceneId] = useState("");
  const [area, setArea] = useState(12);
  const [envelope, setEnvelope] = useState(1.4);
  async function refresh() { const s = await api<State>("/state"); setData(s); return s; }
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, []);
  const project = data?.projects.find(p => p.id === projectId) ?? data?.projects.at(-1);
  const runs = data?.reviews.filter(r => r.projectId === project?.id) ?? [];
  const run = runs.find(r => r.id === runId) ?? runs.at(-1);
  const feedback = data?.feedback.filter(f => f.projectId === project?.id) ?? [];
  const campaign = data?.campaigns.filter(c => c.projectId === project?.id).at(-1);
  const proposals = data?.proposals.filter(p => p.projectId === project?.id) ?? [];
  const scenes = data?.scenes.filter(s => s.projectId === project?.id) ?? [];
  const scene = scenes.find(s => s.id === sceneId) ?? scenes.at(-1);
  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const requirements = { minSuccessRate: minRate, preserveBaselineSuccess: preserve, requireSignificantImprovement: significant, alpha: 0.05 };
  async function create(e: FormEvent) {
    e.preventDefault();
    await perform(async () => {
      const p = await api<Project>("/projects", { title, intendedDecision, requirements });
      setProjectId(p.id); setRunId("");
    }, "任务和验收要求已冻结为版本 1。");
  }
  async function review(selected: CandidateId, feedbackId?: string) {
    if (!project) return;
    const key = `pai-request-${project.id}-${project.revision}-${selected}-${feedbackId ?? "initial"}`;
    const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, requestId);
    await perform(async () => {
      const r = await api<Review>(`/projects/${project.id}/reviews`, { requestId, projectRevision: project.revision, candidate: selected, ...(feedbackId ? { feedbackId } : {}) });
      setRunId(r.id);
      if (r.state !== "completed") throw new Error(r.error ?? r.state);
    }, "原生检查已完成。重复点击会返回同一回执。");
  }
  async function nextFeedback(f: Feedback) {
    const next = ({ received: "reproducible", "needs-context": "reproducible", reproducible: "assigned", assigned: "fix-proposed", rechecked: "closed" } as Record<string, string>)[f.status];
    if (next) return perform(() => api(`/feedback/${f.id}`, { expectedRevision: f.revision, status: next, reason }, "PATCH"), "反馈状态已保存。");
    if (["fix-proposed", "no-change-with-reason"].includes(f.status)) {
      await perform(async () => {
        // One durable identity for this feedback's explicit rollback review.
        const key = `pai-recheck-${f.id}-${project!.revision}-${f.revision}-${f.status}`;
        const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
        sessionStorage.setItem(key, requestId);
        const originalScene = data?.scenes.find(s => s.id === f.runId);
        const originalReview = data?.reviews.find(r => r.id === f.runId);
        const r = f.evidenceKind === "blender-scene"
          ? await api<SceneReview>(`/projects/${project!.id}/scenes`, { requestId, projectRevision: project!.revision, variant: f.status === "no-change-with-reason" ? originalScene!.request.variant : "clear", requirements: originalScene!.request.requirements, feedbackId: f.id })
          : await api<Review>(`/projects/${project!.id}/reviews`, { requestId, projectRevision: project!.revision, candidate: f.status === "no-change-with-reason" ? originalReview!.candidate : "reference", feedbackId: f.id });
        if (f.evidenceKind === "robot-review") setRunId(r.id); else setSceneId(r.id);
        if (r.state !== "completed") throw new Error(r.error ?? r.state);
        await api(`/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason, recheckRunId: r.id }, "PATCH");
      }, "已按记录的处理方案重新检查，并绑定新复测回执。");
    }
  }
  const fAction = (f: Feedback) => ({ received: "记录复现", "needs-context": "补充并复现", reproducible: "分配处理", assigned: "提出回退方案", "fix-proposed": "回退基准并复测", "no-change-with-reason": "复测保留方案", rechecked: "关闭已复测反馈" } as Record<string, string>)[f.status];
  return <div className="shell">
    <aside className="sidebar"><a className="brand" href="/"><span className="brand-mark">P</span><span>PAI<span className="brand-sub">DESIGN WORKBENCH</span></span></a>
      <p className="workspace-label">专业设计工作台 · 01</p>
      <nav aria-label="工作流程">{[["brief", "01", "任务与验收"], ["design", "02", "设计与证据"], ["validation", "03", "原生验证"], ["replay", "04", "失败回放"], ["feedback", "05", "反馈复测"], ["handoff", "06", "推广与交付"]].map(([href, num, text]) => <a key={href} href={`#${href}`}><span>{num}</span>{text}</a>)}</nav>
      <div className="scope-note"><span className="status-dot" /> 记录仿真评审<p>30 条真实历史记录<br />1 个任务 · 10 个配对种子<br />尚未进行现场验证</p></div>
      <p className="sidebar-footer">Radar → Design → EvalArc<br />Robot Reel → Feedback</p>
    </aside>
    <main>
      <header><div><div className="eyebrow">PHYSICAL AI / DESIGN REVIEW</div><h1>让设计决策有证据。</h1><p>从需求到失败案例，再到可复测的反馈闭环。</p></div><span className="version">WORKBENCH · v0.1{data?.capabilities.authenticatedWorkspace && <><br /><a href="/logout">退出登录</a></>}</span></header>
      <div className="scope-banner"><strong>当前验证范围</strong><span>历史策略记录核验 + 合成静态场景几何检查；尚未执行新的策略推理、动力学或现场验证。结论仅适用于各自证据范围。</span></div>
      {error && <div role="alert" className="alert error">{error}</div>}
      {notice && <div role="status" className="alert">{notice}</div>}
      {busy && <div role="status" className="busy">正在执行原生检查并保存回执…</div>}
      <section id="brief" className="panel">
        <div className="section-top"><div><div className="eyebrow">01 / BRIEF</div><h2>任务与验收边界</h2></div><span className="pill">{project ? `需求 v${project.revision}` : "新任务"}</span></div>
        {data && data.projects.length > 0 && <label className="project-select">已有任务<select aria-label="选择已有任务" value={project?.id ?? ""} onChange={e => { setProjectId(e.target.value); setRunId(""); }} >{data.projects.map(p => <option key={p.id} value={p.id}>{p.title} · v{p.revision}</option>)}</select></label>}
        <form onSubmit={create}>
          <div className="form-grid"><label>任务名称<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label><label>准备作出的决策<textarea required minLength={5} value={intendedDecision} onChange={e => setIntended(e.target.value)} /></label></div>
          <div className="criteria"><label>样本最低成功率<select value={minRate} onChange={e => setMinRate(Number(e.target.value))}><option value={0.4}>40%</option><option value={0.5}>50%</option><option value={0.7}>70%</option><option value={0.8}>80%</option></select></label><label className="check"><input type="checkbox" checked={preserve} onChange={e => setPreserve(e.target.checked)} />保留基准成功案例</label><label className="check"><input type="checkbox" checked={significant} onChange={e => setSignificant(e.target.checked)} />要求统计显著改善（Holm α=.05）</label></div>
          <div className="form-footer"><p>新任务冻结需求；后续评审绑定同一版本。</p><button disabled={busy} type="submit">{project ? "创建独立新任务" : "创建评审任务"} ↗</button></div>
        </form>
        {project && <div className="frozen"><strong>已冻结</strong> {project.title} · 最低 {project.requirements.minSuccessRate * 100}% · 保留基准：{project.requirements.preserveBaselineSuccess ? "是" : "否"} · 显著改善：{project.requirements.requireSignificantImprovement ? "是" : "否"}</div>}
      </section>
      <section id="industrial" className="panel">
        <div className="section-top"><div><div className="eyebrow">02B / NATIVE INDUSTRIAL SCENE</div><h2>Blender 工业场景设计</h2></div><span className="pill">{scene?.candidate?.blenderVersion ? `Blender ${scene.candidate.blenderVersion}` : "原生 Blender · 待执行"}</span></div>
        <p className="muted">显式合成工作单元：4m × 3m。检查静态占地、声明的目标包络与相机可见性；不代表真实机器人可达性、DFM 或动力学验证。</p>
        <div className="event-form"><label>设计变体<select aria-label="Blender 设计变体" value={sceneVariant} onChange={e => setSceneVariant(e.target.value as typeof sceneVariant)}><option value="occluded">带遮挡的相机布局</option><option value="clear">移除遮挡的基准布局</option></select></label><label>最大占地 m²<input type="number" min={1} max={100} step={0.1} value={area} onChange={e => setArea(Number(e.target.value))} /></label><label>声明的目标包络半径 m<input type="number" min={0.1} max={10} step={0.1} value={envelope} onChange={e => setEnvelope(Number(e.target.value))} /></label><button disabled={busy || !project || !data?.capabilities.blender} onClick={() => perform(async () => {
          const req = { maxFootprintArea: area, targetEnvelopeRadius: envelope, requireTargetVisible: true };
          const key = `pai-scene-${project!.id}-${project!.revision}-${sceneVariant}-${JSON.stringify(req)}`;
          const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID(); sessionStorage.setItem(key, requestId);
          const s = await api<SceneReview>(`/projects/${project!.id}/scenes`, { requestId, projectRevision: project!.revision, variant: sceneVariant, requirements: req });
          setSceneId(s.id);
          if (s.state !== "completed") throw new Error(s.error ?? s.state);
        }, "原生 Blender 场景和独立检查已生成。")}>生成并检查 Blender 场景</button></div>
        {!data?.capabilities.blender && <p className="muted">需安装原生 Blender 并配置 PAI_BLENDER；已有历史仿真闭环可独立使用。</p>}
        {scenes.length > 0 && <label className="project-select">场景检查记录<select aria-label="选择场景检查记录" value={scene?.id ?? ""} onChange={e => setSceneId(e.target.value)}>{scenes.map(s => <option key={s.id} value={s.id}>{s.request.variant === "occluded" ? "遮挡布局" : "基准布局"} · {s.verdict ?? s.state} · {s.id.slice(0, 8)}</option>)}</select></label>}
        {scene && <><div className={`decision ${scene.verdict === "rejected" ? "rejected" : ""}`}><div><span>原生几何评审</span><h3>{scene.state === "completed" ? scene.verdict === "rejected" ? "场景检查拒绝" : "静态场景检查通过" : scene.state}</h3><p>{scene.error ?? `EvalArc 检测到 ${scene.diff?.blocking_changes ?? "待定"} 项丢失的检查；静态几何结论不外推到动态执行。`}</p></div></div>
          {scene.state === "completed" && <><div className="videos scene-previews">{(["baseline", "candidate"] as const).map(which => <figure key={`${scene.id}-${which}`}><div className="video-label"><strong>{which === "baseline" ? "基准布局" : "候选布局"}</strong><span>原生 Cycles 渲染</span></div><img alt={`${which === "baseline" ? "基准" : "候选"}合成工作单元原生渲染`} src={`/api/scenes/${scene.id}/files/${which}/preview.png`} /><figcaption>场景文件与渲染均保留 SHA-256。</figcaption></figure>)}</div>
            <div className="check-list">{scene.candidate?.checks.map(c => {
              const observed = typeof c.observed === "number" ? c.observed.toFixed(2) : "未知";
              const required = typeof c.required === "number" ? c.required.toFixed(2) : "未知";
              const hit = c.firstHit === "Target" ? "目标中心" : c.firstHit === "Visibility obstruction" ? "遮挡物" : "其他物体";
              const detail = c.id === "footprint-area" ? `占地 ${observed} m²；允许上限 ${required} m²`
                : c.id === "declared-target-envelope" ? `目标平面距离 ${observed} m；声明包络半径 ${required} m，不代表关节可达性`
                : `相机射线首先命中${hit}；原生投影与射线检查${c.passed ? "通过" : "失败"}`;
              return <div key={c.id}><span className={`check-icon ${!c.passed ? "fail" : ""}`}>{c.passed ? "✓" : "×"}</span><div><strong>{{ "footprint-area": "静态占地", "declared-target-envelope": "声明的目标包络", "camera-visibility": "原生相机射线可见性" }[c.id]}</strong><p>{detail}</p></div></div>;
            })}</div>
            <div className="artifact-links"><a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/scene.blend`}>下载可编辑 .blend</a><a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/scene.glb`}>下载 GLB</a><a className="button secondary" href={`/api/scenes/${scene.id}/files/candidate/checks.json`}>下载原生检查</a>
              <button className="secondary" disabled={busy || scene.candidate?.checks.find(c => c.id === "camera-visibility")?.passed !== false || scene.baseline?.checks.find(c => c.id === "camera-visibility")?.passed !== true} onClick={() => perform(() => api("/feedback", { runId: scene.id, evidenceKind: "blender-scene", kind: "design-check", checkId: "camera-visibility", seed: null, expected: "相机射线首先命中目标", observed: "原生射线被遮挡物阻挡，需要移除遮挡并复测", actorKind: "maintainer" }), "原生场景反馈已绑定可见性检查。")}>记录遮挡反馈</button>
              <button className="secondary" disabled={busy} onClick={() => perform(() => api("/campaigns", { runId: scene.id, evidenceKind: "blender-scene", channel: "direct-pilot" }), "场景试用草稿已生成，尚未发送。")}>生成场景案例草稿</button>
            </div></>}
          <details><summary>原生场景回执</summary><pre>{JSON.stringify(scene, null, 2)}</pre></details></>}
        <details><summary>主流软件接入分工</summary><p className="muted">Blender：场景与资产；FreeCAD/CadQuery：工程几何与约束；Onshape/Fusion/SolidWorks/NX/CATIA：原生专业工作流与授权接口；Gazebo/Isaac Sim：机器人仿真。当前只将已执行的 Blender 与记录检查显示为可用。</p><a href="https://docs.blender.org/api/current/" target="_blank" rel="noreferrer">Blender 官方 API ↗</a> · <a href="https://www.freecad.org/features.php" target="_blank" rel="noreferrer">FreeCAD 官方功能 ↗</a> · <a href="https://cadquery.readthedocs.io/en/latest/importexport.html" target="_blank" rel="noreferrer">CadQuery 格式边界 ↗</a></details>
      </section>
      <section id="design" className="panel">
        <div className="section-top"><div><div className="eyebrow">02 / DESIGN EVIDENCE</div><h2>候选设计与专业线索</h2></div><span className="pill">可复用的原生工具</span></div>
        <div className="candidates">{(["reference", "camera", "dim"] as CandidateId[]).map(c => <button disabled={busy} key={c} className={`candidate ${candidate === c ? "selected" : ""}`} onClick={() => setCandidate(c)}><span className="candidate-tag">{c.toUpperCase()}</span><strong>{labels[c]}</strong><span>{c === "reference" ? "固定原始视角与光照" : c === "camera" ? "相机平移 +0.12m" : "光照降为基准的 25%"}</span><small>设计条件对比 · 同一模型</small></button>)}</div>
        <div className="design-note"><strong>当前设计提案</strong><p>对比 {labels[candidate]} 与基准的配对结果，检查总成功数、丢失的成功样本和混杂因素。若出现 seed 9 回归，优先回退再复测；新的布局优化需要另行采集原生实验记录。</p></div>
        <div className="form-footer"><p>模型提案无权修改验收标准或发布结果。</p><button className="secondary" disabled={busy || !project || !data?.capabilities.modelProposal} onClick={() => perform(() => {
          const profiles = ["kiro-primary", "kiro-backup", "kiro-backup2"];
          const key = `pai-proposal-${project!.id}-${project!.revision}`;
          const previous = proposals.find(p => p.request.projectRevision === project!.revision && JSON.stringify(p.request.profiles) === JSON.stringify(profiles));
          const requestId = previous?.request.requestId ?? sessionStorage.getItem(key) ?? crypto.randomUUID();
          sessionStorage.setItem(key, requestId);
          return api(`/projects/${project!.id}/proposals`, { requestId, projectRevision: project!.revision, profiles });
        }, "原生控制器已返回提案状态，请查看回执。")}>请求受控模型提案</button></div>
        {!data?.capabilities.modelProposal && <p className="muted">受控模型提案尚未配置：需现有控制器入口和经过审查的预算账本。</p>}
        {proposals.map(p => <details key={p.id}><summary>模型提案 · {p.state}</summary><pre>{p.answer ?? p.error ?? JSON.stringify(p.report, null, 2)}</pre></details>)}
        {run?.radar && <details><summary>Radar 专业线索 · 快照 {run.radar.date}</summary><p className="muted">来源索引及作者陈述，尚未逐项复核；不参与验收结论。</p><div className="sources">{run.radar.picked.slice(0, 5).map(s => <a key={s.id} href={s.url} target="_blank" rel="noreferrer"><span className="pill">{s.evidence}</span><div>{s.title}<small>{s.published} · {s.lane}</small></div><span>↗</span></a>)}</div></details>}
      </section>
      <section id="validation" className="panel">
        <div className="section-top"><div><div className="eyebrow">03 / NATIVE VALIDATION</div><h2>独立检查，保留失败</h2></div><button disabled={busy || !project} onClick={() => review(candidate)}>验证 {labels[candidate]} ↗</button></div>
        <div className="connector-row"><span>RADAR · 来源快照</span><span>ROBOT REEL · 原生核验</span><span>EVALARC · JUnit 对照</span><span>CONTROL · {run?.controller?.state ?? "待读取"}</span></div>
        {runs.length > 0 && <label className="project-select">检查记录<select aria-label="选择检查记录" value={run?.id ?? ""} onChange={e => setRunId(e.target.value)}>{runs.map(r => <option key={r.id} value={r.id}>{labels[r.candidate]} · {r.state} · {r.id.slice(0, 8)}</option>)}</select></label>}
        {run ? <>
          <div className={`decision ${run.decision?.verdict === "rejected" ? "rejected" : ""}`}><div><span>验收结论 · {labels[run.candidate]}</span><h3>{run.decision ? labels[run.decision.verdict] : run.state}</h3><p>{run.error ?? (run.diff?.blocking_changes ? `配对记录丢失 ${run.diff.blocking_changes} 个基准成功案例；${run.project.requirements.preserveBaselineSuccess ? "当前验收要求保留这些案例。" : "此任务未将保留基准设为硬性验收要求。"}`
            : "记录检查已保存；该结论不外推到真实工业环境。")}</p></div><span className="decision-symbol">{run.decision?.verdict === "rejected" ? "!" : "✓"}</span></div>
          <div className="metric-grid">{run.stress?.conditions.map(c => <div className="metric" key={c.id}><span>{labels[c.id]}</span><strong>{c.successes}<small>/ {c.trials}</small></strong><p>Wilson 95% · {c.wilson95.map(n => `${(n * 100).toFixed(1)}%`).join(" – ")}</p></div>)}</div>
          <div className="check-list">{run.decision?.checks.map(c => <div key={c.id}><span className={`check-icon ${c.passed === false ? "fail" : ""}`}>{c.passed === null ? "—" : c.passed ? "✓" : "×"}</span><div><strong>{{ "minimum-recorded-success": "最低成功率", "preserve-baseline-success": "基准成功保留", "independent-improvement": "统计改善要求" }[c.id]}</strong><p>{c.detail}</p></div></div>)}</div>
          <details><summary>检查回执与来源指纹 · {run.id.slice(0, 8)}</summary><pre>{JSON.stringify({ request: run.request, requirementDigest: run.requirementDigest, sourceDigests: run.sourceDigests, receipts: run.receipts, controller: run.controller }, null, 2)}</pre></details>
        </> : <div className="empty">创建任务并执行检查，查看真实原生结果。</div>}
      </section>
      <section id="replay" className="panel">
        <div className="section-top"><div><div className="eyebrow">04 / FAILURE REPLAY</div><h2>直接查看证据</h2></div><label className="seed">配对种子<select aria-label="配对种子" value={seed} onChange={e => setSeed(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i} value={i}>seed {i}</option>)}</select></label></div>
        {run?.state === "completed" ? <><div className="videos">{(["reference", run.candidate === "reference" ? "camera" : run.candidate] as CandidateId[]).map(c => <figure key={`${run.id}-${c}-${seed}`}><div className="video-label"><strong>{labels[c]}</strong><span>seed {seed} · 原始记录</span></div><video controls preload="metadata" playsInline src={`/api/runs/${run.id}/media/${c}/${seed}/main`} /><figcaption>视频内容 SHA-256 与本次核验的原始清单匹配。</figcaption></figure>)}</div><p className="muted">seed 9：基准成功，相机和弱光均失败。不同条件的录制长度可能不同。</p></> : <div className="empty">完成核验后开放绑定本次回执的视频。</div>}
      </section>
      <section id="feedback" className="panel">
        <div className="section-top"><div><div className="eyebrow">05 / FEEDBACK LOOP</div><h2>反馈必须落到复测</h2></div><span className="pill">{feedback.filter(f => f.status === "closed").length} 已闭环</span></div>
        <div className="form-grid"><label>预期结果<textarea value={expected} onChange={e => setExpected(e.target.value)} /></label><label>观察结果<textarea value={observed} onChange={e => setObserved(e.target.value)} /></label></div>
        <div className="form-footer"><p>绑定当前检查与 seed {seed}；此次操作记为维护者验证。</p><button className="secondary" disabled={busy || run?.state !== "completed"} onClick={() => perform(() => api("/feedback", { runId: run!.id, kind: "regression", seed, expected, observed, actorKind: "maintainer" }), "反馈已绑定原始证据。")}>记录案例反馈</button></div>
        <label>处理与复测说明<textarea minLength={5} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="feedback-list">{feedback.map(f => <article key={f.id}><div className="feedback-heading"><strong>{f.evidenceKind === "blender-scene" ? `Blender · ${f.checkId}` : `seed ${f.seed}`} · {f.observed}</strong><span className="pill">{labels[f.status]}</span></div><p>来源：{f.actorKind} · 版本 {f.revision} · {f.id.slice(0, 8)}</p><div className="history">{f.history.map((h, i) => <span key={i}>{labels[h.status]}</span>)}</div><details><summary>处理记录</summary>{f.history.map((h, i) => <p key={i}>{labels[h.status]} · {h.reason}{h.recheckRunId && <small>复测 {h.recheckRunId}</small>}</p>)}</details>{f.status !== "closed" && <button disabled={busy} onClick={() => nextFeedback(f)}>{fAction(f)}</button>}</article>)}</div>
      </section>
      <section id="handoff" className="panel">
        <div className="section-top"><div><div className="eyebrow">06 / HANDOFF & PILOT</div><h2>可核验交付与推广反馈</h2></div><span className="pill">草稿 · 不自动发送</span></div>
        <div className="handoff-grid"><div><h3>证据交付包</h3><p>需求、原生结果、检查映射和回执组成 8 文件包，可在另一台机器重新对照。</p>{run?.state === "completed" && <a className="button secondary" href={`/api/runs/${run.id}/bundle`}>下载完整证据包 ↓</a>}<label className="file-label">验证下载的包<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void perform(async () => { const r = await api<{ valid: boolean; files: number }>("/bundles/verify", JSON.parse(await file.text())); setVerified(`${r.files} 个文件通过完整性与语义对照；来源认证与物理验证尚未建立。`); }, "交付包验证完成。"); }} /></label>{verified && <p role="status">{verified}</p>}</div>
        <div><h3>推广草稿</h3><p>技术案例保留失败和范围限制；试用反馈单独计量。</p><button className="secondary" disabled={busy || run?.state !== "completed"} onClick={() => perform(() => api("/campaigns", { runId: run!.id, channel: "direct-pilot" }), "试用邀请草稿已生成，尚未发送。")}>生成试用案例草稿</button>{campaign && <details open><summary>直接试用 · 草稿</summary><pre>{campaign.text}</pre></details>}</div></div>
        <div className="pilot-metrics"><div><strong>{data?.metrics.independentParticipants ?? 0}</strong><span>独立试用者（自报）</span></div><div><strong>{data?.metrics.independentRepeatUsers ?? 0}</strong><span>独立再次使用者</span></div><div><strong>{data?.metrics.maintainerEvents ?? 0}</strong><span>维护者测试事件</span></div></div>
        <p className="muted">没有曝光分母，转化率不计算；维护者和自动测试不计入独立采用数据。</p>
        {campaign && <div className="event-form"><label>匿名参与者标识<input value={participant} onChange={e => setParticipant(e.target.value)} /></label><label>参与者类型<select value={actor} onChange={e => setActor(e.target.value as typeof actor)}><option value="maintainer">维护者测试</option><option value="independent">独立参与者（自报）</option><option value="fixture">自动测试</option></select></label><label>实际观察事件<select value={eventKind} onChange={e => setEventKind(e.target.value)}><option value="started">开始试用</option><option value="completed">完成试用</option><option value="evidence-reopened">重新打开证据</option><option value="feedback">提供反馈</option><option value="repeat-use">再次使用</option></select></label><button disabled={busy} onClick={() => perform(() => api("/events", { eventId: crypto.randomUUID(), campaignId: campaign.id, participantId: participant, actorKind: actor, kind: eventKind }), "观察事件已保存。")}>记录实际事件</button></div>}
      </section>
      <footer>PAI Design Workbench · native evidence, reviewable decisions.<span>Web / PWA · 桌面与移动原生壳规划中 · CAD/DFM 待接入</span></footer>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => { /* Installability is optional; never queue API commands offline. */ });
