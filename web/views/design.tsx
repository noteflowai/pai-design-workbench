import { useEffect, useState } from "react";
import { api, requestIdFor } from "../api";
import { CANDIDATES, useApp } from "../context";
import { Card, Chip, Empty, ViewHeader, time } from "../ui";
import { runCad, runFactory, runReview, runScene } from "../actions";
import { SweepPanel } from "./sweep";
import { PlantLane } from "../plant";
import { CAD_DRAFT_KEY, CAD_VARIANTS, ISOLATION_LABEL } from "../context";
import type { CandidateId } from "../../src/contracts";

const LANES = [["robot", "机器人记录评审"], ["scene", "Blender 场景"], ["plant", "工厂产线"], ["cad", "CAD 零件"], ["factory", "工厂孪生"]] as const;
type Lane = typeof LANES[number][0];
const CANDIDATE_NOTES: Record<CandidateId, string> = { reference: "固定原始视角与光照", camera: "相机平移 +0.12 m", dim: "光照降为基准的 25%" };

export function Design() {
  const c = useApp();
  const { project, route } = c;
  const lane = (LANES.some(([id]) => id === route.params.get("lane")) ? route.params.get("lane") : "robot") as Lane;
  if (!project) return <><ViewHeader step="阶段 2 / 6 · 候选设计" title="候选设计" />
    <Empty title="先冻结需求" action={<button type="button" onClick={() => c.navigate("requirements", { new: "1" })}>新建评审任务</button>}>候选设计与检查都绑定一个冻结的需求版本。</Empty></>;
  return <>
    <ViewHeader step="阶段 2 / 6 · 候选设计" title="候选设计" description={`定义候选并提交原生验证；全部绑定需求 v${project.revision}。也可以在 AI 助手中描述意图生成计划。`}
      actions={<button type="button" className="secondary" onClick={c.openAssistant}>用 AI 助手描述</button>} />
    <div className="tabs" role="tablist" aria-label="证据类型">{LANES.map(([id, label]) =>
      <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={lane === id} aria-controls={`lane-${id}`} className={lane === id ? "active" : ""}
        onClick={() => c.navigate("design", { lane: id })}>{label}</button>)}</div>
    <div role="tabpanel" id={`lane-${lane}`} aria-labelledby={`tab-${lane}`}>
      {lane === "robot" ? <RobotLane /> : lane === "scene" ? <SceneLane /> : lane === "plant" ? (c.data.capabilities.blender ? <PlantLane /> : <SceneLane />) : lane === "cad" ? <CadLane /> : <FactoryLane />}
    </div>
  </>;
}

function RobotLane() {
  const c = useApp();
  const [candidate, setCandidate] = useState<CandidateId>("camera");
  const proposals = c.data.proposals.filter(p => p.projectId === c.project!.id);
  const radar = c.data.reviews.filter(r => r.projectId === c.project!.id && r.radar).at(-1)?.radar;
  return <>
    <Card title="候选条件" aside={<small>SmolVLA · LIBERO task 0 · 同一模型</small>}>
      <div className="options" role="radiogroup" aria-label="候选条件">{(["reference", "camera", "dim"] as CandidateId[]).map(id =>
        <label key={id} className={`option ${candidate === id ? "selected" : ""}`}><input type="radio" name="candidate" value={id} checked={candidate === id} onChange={() => setCandidate(id)} />
          <span className="option-tag">{id.toUpperCase()}</span><strong>{CANDIDATES[id]}</strong><small>{CANDIDATE_NOTES[id]}</small></label>)}</div>
      <p className="muted">对比候选与基准的 10 个配对种子：总成功数、丢失的基准成功样本与精确配对检验。结论仅适用于记录样本。</p>
      <div className="form-foot"><small>Robot Reel 原生核验 → 稳定种子 JUnit → EvalArc 独立对照</small>
        <button type="button" disabled={c.busy} onClick={() => void runReview(c, candidate)}>提交验证：{CANDIDATES[candidate]}</button></div>
    </Card>
    <Card title="受控模型提案" aside={<Chip tone={c.data.capabilities.modelProposal ? "info" : "muted"}>{c.data.capabilities.modelProposal ? "已配置" : "未配置"}</Chip>}>
      <p className="muted">文本提案无权修改验收标准或发布结果；需要既有控制器入口与经过审查的预算账本。</p>
      <div className="form-foot"><small>{proposals.length} 条提案记录</small><button type="button" className="secondary" disabled={c.busy || !c.data.capabilities.modelProposal} onClick={() => void c.perform(() => {
        const profiles = ["kiro-primary", "kiro-backup", "kiro-backup2"];
        const requestId = requestIdFor(`pai-proposal-${c.project!.id}-${c.project!.revision}`);
        return api(`/projects/${c.project!.id}/proposals`, { requestId, projectRevision: c.project!.revision, profiles });
      }, "原生控制器已返回提案状态，请查看回执。")}>请求受控模型提案</button></div>
      {proposals.map(p => <details key={p.id}><summary>模型提案 · {p.state}</summary><pre>{p.answer ?? p.error ?? JSON.stringify(p.report, null, 2)}</pre></details>)}
    </Card>
    {radar && <Card title="专业线索" aside={<small>Radar 快照 {radar.date} · 不参与验收</small>}>
      <ul className="sources">{radar.picked.slice(0, 5).map(s => <li key={s.id}><a href={s.url} target="_blank" rel="noreferrer"><Chip>{s.evidence}</Chip><span>{s.title}<small>{s.published} · {s.lane}</small></span><span aria-hidden="true">↗</span></a></li>)}</ul>
    </Card>}
  </>;
}

function SceneLane() {
  const c = useApp();
  const q = c.route.params;
  const [variant, setVariant] = useState<"clear" | "occluded">((q.get("variant") as "clear" | "occluded") ?? "occluded");
  const [area, setArea] = useState(Number(q.get("area") ?? 12));
  const [radius, setRadius] = useState(Number(q.get("radius") ?? 1.4));
  const [visible, setVisible] = useState(q.get("visible") !== "false");
  useEffect(() => { if (q.get("variant")) c.toast("计划参数已填入 Blender 专业面板，可调整后执行。"); }, []);
  if (!c.data.capabilities.blender) return <Empty title="未配置原生 Blender" action={<InstallTool kind="blender" />}>设置 PAI_BLENDER 指向原生 Blender 可执行文件；其他证据类型不受影响。</Empty>;
  return <Card title="Blender 工作单元（合成静态几何）" aside={<small>4 m × 3 m 显式配方</small>}>
    <div className="field-grid">
      <label>设计变体<select aria-label="Blender 设计变体" value={variant} onChange={e => setVariant(e.target.value as typeof variant)}>
        <option value="occluded">带遮挡的相机布局</option><option value="clear">移除遮挡的基准布局</option></select></label>
      <label>最大占地<span className="unit-input"><input type="number" min={1} max={100} step={0.1} value={area} onChange={e => setArea(Number(e.target.value))} /><em>m²</em></span></label>
      <label>声明的目标包络半径<span className="unit-input"><input type="number" min={0.1} max={10} step={0.1} value={radius} onChange={e => setRadius(Number(e.target.value))} /><em>m</em></span></label>
      <label className="inline"><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} />要求检查相机可见目标</label>
    </div>
    <p className="muted">基准（无遮挡）与候选各生成一次：原生 .blend、GLB、Cycles 渲染、射线与投影检查；每个构建阶段实时推送到三维视口。不代表关节可达性、动力学或 DFM。</p>
    <div className="form-foot"><small>Blender 5.2 原生执行 → EvalArc 独立对照</small>
      <button type="button" disabled={c.busy} onClick={() => void runScene(c, variant, { maxFootprintArea: area, targetEnvelopeRadius: radius, requireTargetVisible: visible })}>生成并检查 Blender 场景</button></div>
  </Card>;
}

function FactoryLane() {
  const c = useApp();
  const criteria = (c.data.factoryCriteria ?? []).filter(x => x.projectId === c.project!.id && x.projectRevision === c.project!.revision);
  const [id, setId] = useState("");
  const selected = criteria.find(x => x.id === id) ?? criteria.at(-1);
  return <Card title="维护与能源方案" aside={<Chip>演示仿真 · 未校准</Chip>}>
    <p className="muted">Robot Reel v0.18.0 Factory Twin：六工位产线、AMR、车间温控与能源；同扰动下的闭环 / 影子配对。导入逐字节复核的 seeds.json 与 manifest.json，上游摘要与自检不参与验收。</p>
    {criteria.length === 0 ? <Empty title="尚未冻结工厂验收标准" action={<button type="button" onClick={() => c.navigate("requirements", {})}>先冻结标准</button>}>
      标准必须在导入证据之前冻结。</Empty> : <>
      <label>冻结的标准版本<select aria-label="选择工厂标准版本" value={selected?.id ?? ""} onChange={e => setId(e.target.value)}>{criteria.map(x =>
        <option key={x.id} value={x.id}>{time(x.createdAt)} · 损失 ≤ {x.criteria.maxOutputLossPerSeed} · EV ≥ {Math.round(x.criteria.minEvServiceRatio * 100)}% · {x.digest.slice(0, 8)}</option>)}</select></label>
      <div className="form-foot"><small>摘要与大小校验 → 影子模式只观察 → 重算上游摘要 → 逐种子评估</small>
        <button type="button" disabled={c.busy || !selected} onClick={() => void runFactory(c, selected!.id)}>导入已复核样本并评估</button></div>
    </>}
  </Card>;
}

function CadLane() {
  const c = useApp();
  const q = c.route.params;
  const cap = c.data.capabilities.cad;
  const defaults = cap ? cap.defaultRequirements : { maxMassG: 80, minWallMm: 3, edgeDistanceFactor: 1.5, requireNoInterference: true, maxEnvelopeMm: [80, 40, 60] as [number, number, number] };
  const [variant, setVariant] = useState(q.get("variant") ?? "lightweight");
  const [mass, setMass] = useState(Number(q.get("mass") ?? defaults.maxMassG));
  const [wall, setWall] = useState(Number(q.get("wall") ?? defaults.minWallMm));
  const [edge, setEdge] = useState(Number(q.get("edge") ?? defaults.edgeDistanceFactor));
  const [fit, setFit] = useState(defaults.requireNoInterference);
  const sandbox = cap ? cap.generatedCode : undefined;
  const [code, setCode] = useState(() => sessionStorage.getItem(CAD_DRAFT_KEY) ?? sandbox?.template ?? "");
  const [codeCheck, setCodeCheck] = useState<{ ok: boolean; violations: string[] }>();
  useEffect(() => { if (code) sessionStorage.setItem(CAD_DRAFT_KEY, code); setCodeCheck(undefined); }, [code]);
  const feedback = q.get("feedback") ? c.data.feedback.find(f => f.id === q.get("feedback") && f.status === "fix-proposed") : undefined;
  const generated = variant === "generated";
  if (!cap) return <Empty title="未配置 CadQuery" action={<InstallTool kind="cadquery" />}>运行 npm run setup:cad（哈希锁定的 CadQuery 2.8.0 / OCCT 7.9），或设置 PAI_CADQUERY_PYTHON。</Empty>;
  return <><Card title="NEMA 17 电机安装支架（参数化 B-Rep）" aside={<small>{cap.engine} · 6061 铝</small>}>
    {feedback && <p className="notice" role="status">反馈复测：修改代码后提交，新回执将绑定到反馈「{feedback.observed.slice(0, 40)}」；零件要求保持不变。</p>}
    <div className="options" role="radiogroup" aria-label="CAD 候选参数">{Object.entries(CAD_VARIANTS).filter(([id]) => id !== "parametric").map(([id, [label, note]]) => {
      const off = id === "generated" && !sandbox?.available;
      return <label key={id} className={`option ${variant === id ? "selected" : ""} ${off ? "disabled" : ""}`} title={off ? sandbox?.reason : undefined}>
        <input type="radio" name="cad-variant" value={id} checked={variant === id} disabled={off} onChange={() => setVariant(id)} />
        <span className="option-tag">{id === "generated" ? "CODE" : id.toUpperCase()}</span><strong>{label}</strong><small>{off ? `不可用：${sandbox?.reason ?? "沙箱未就绪"}` : note}</small></label>;
    })}</div>
    {generated && sandbox?.available && <div className="code-editor">
      <label htmlFor="cad-code">CadQuery 代码<small>只能 import cadquery as cq / math；给 result（一个实体）与 MOTOR_AXIS_Z 赋值。电机安装面 y=0，电机轴经过 x=0、z=MOTOR_AXIS_Z。</small></label>
      <textarea id="cad-code" spellCheck={false} rows={18} value={code} onChange={e => setCode(e.target.value)} aria-describedby="cad-code-status" />
      <div className="code-tools" id="cad-code-status" aria-live="polite">
        <button type="button" className="secondary" disabled={c.busy || !code.trim()} onClick={() => void api<{ ok: boolean; violations: string[] }>("/cad/code-check", { code }).then(setCodeCheck)
          .catch(e => c.toast(e instanceof Error ? e.message : String(e), "bad"))}>检查代码策略</button>
        <button type="button" className="secondary" disabled={c.busy} onClick={() => setCode(sandbox.template)}>恢复模板</button>
        {codeCheck && (codeCheck.ok ? <span className="chip ok">符合沙箱策略</span>
          : <ul className="violations">{codeCheck.violations.map(v => <li key={v}>{v}</li>)}</ul>)}
      </div>
      <p className="muted">隔离：{sandbox.isolation.map(x => ISOLATION_LABEL[x] ?? x).join(" · ")}。代码只产生实体；结论来自与预设相同的原生 B-Rep 检查。</p>
    </div>}
    <div className="field-grid" style={{ marginTop: 14 }}>
      <label>质量上限<span className="unit-input"><input type="number" min={1} max={10000} step={1} disabled={Boolean(feedback)} value={mass} onChange={e => setMass(Number(e.target.value))} /><em>g</em></span></label>
      <label>最小壁厚<span className="unit-input"><input type="number" min={0.5} max={50} step={0.1} disabled={Boolean(feedback)} value={wall} onChange={e => setWall(Number(e.target.value))} /><em>mm</em></span></label>
      <label>孔边距系数<span className="unit-input"><input type="number" min={1} max={4} step={0.1} disabled={Boolean(feedback)} value={edge} onChange={e => setEdge(Number(e.target.value))} /><em>× d</em></span></label>
      <label className="inline"><input type="checkbox" disabled={Boolean(feedback)} checked={fit} onChange={e => setFit(e.target.checked)} />要求与 NEMA 17 电机无装配干涉</label>
    </div>
    <p className="muted">基准参数与候选各生成一次：可编辑 STEP、STL、GLB 与 SVG 工程视图；在 OCCT B-Rep 上实测接口尺寸、壁厚、孔边距、质量与电机装配干涉。名义几何与 DFM 经验规则，不含 FEA、公差叠加或实物测试。</p>
    <div className="form-foot"><small>CadQuery 原生建模 → B-Rep 检查 → EvalArc 独立对照</small>
      <button type="button" disabled={c.busy || (generated && (!sandbox?.available || !code.trim()))} onClick={() => {
        const original = feedback ? (c.data.cads ?? []).find(x => x.id === feedback.runId) : undefined;
        const requirements = original?.request.requirements ?? { maxMassG: mass, minWallMm: wall, edgeDistanceFactor: edge, requireNoInterference: fit, maxEnvelopeMm: defaults.maxEnvelopeMm };
        void runCad(c, variant, requirements, generated ? code : undefined, feedback);
      }}>{feedback ? "提交修订代码并复测" : generated ? "在沙箱中运行并检查" : "生成并检查 CAD 零件"}</button></div>
  </Card>
  {!feedback && <SweepPanel requirements={{ maxMassG: mass, minWallMm: wall, edgeDistanceFactor: edge, requireNoInterference: fit, maxEnvelopeMm: defaults.maxEnvelopeMm }} />}
  </>;
}

/** Desktop app only: install the pinned tool through the shell (official SHA-256 / hash-locked), then the server restarts. */
function InstallTool({ kind }: { kind: "blender" | "cadquery" }) {
  const desktop = (window as unknown as { paiDesktop?: {
    info(): Promise<{ installers: Record<"blender" | "cadquery", boolean> }>;
    installTool(k: string): Promise<void>;
  } }).paiDesktop;
  const [available, setAvailable] = useState<boolean>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (desktop) void desktop.info().then(info => { if (active) setAvailable(info.installers?.[kind] === true); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [desktop, kind]);
  if (!desktop) return null;
  if (available === false) return <p className="muted">此平台请在“工具”菜单选择已有的 {kind === "blender" ? "Blender 可执行文件" : "CadQuery Python"}。自动安装目前支持 Linux x64。</p>;
  return <>
    <button type="button" disabled={!available} onClick={() => {
      setError("");
      void desktop.installTool(kind).catch(e => setError(String(e.message ?? e)));
    }}>{kind === "blender" ? "安装 Blender 5.2.2 LTS（官方校验）" : "安装 CadQuery 2.8（哈希锁定）"}</button>
    {error && <p role="alert">{error}</p>}
  </>;
}
