import { useEffect, useState } from "react";
import { api, requestIdFor } from "../api";
import { CANDIDATES, useApp } from "../context";
import { Card, Chip, Empty, ViewHeader, time } from "../ui";
import { runFactory, runReview, runScene } from "../actions";
import type { CandidateId } from "../../src/contracts";

const LANES = [["robot", "机器人记录评审"], ["scene", "Blender 场景"], ["factory", "工厂孪生"]] as const;
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
      {lane === "robot" ? <RobotLane /> : lane === "scene" ? <SceneLane /> : <FactoryLane />}
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
  if (!c.data.capabilities.blender) return <Empty title="未配置原生 Blender">设置 PAI_BLENDER 指向原生 Blender 可执行文件；其他证据类型不受影响。</Empty>;
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
