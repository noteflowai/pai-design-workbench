import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Card, Chip, ViewHeader, time } from "../ui";
import { FactoryCriteriaForm } from "../factory";
import type { Project } from "../../src/contracts";
import type { FactoryCriteriaValues } from "../../src/factory";

type Req = Project["requirements"];
function RequirementFields({ value, onChange }: { value: Req; onChange: (r: Req) => void }) {
  return <div className="field-row">
    <label>样本最低成功率<select value={value.minSuccessRate} onChange={e => onChange({ ...value, minSuccessRate: Number(e.target.value) })}>
      {[0.4, 0.5, 0.7, 0.8].map(v => <option key={v} value={v}>{v * 100}%</option>)}</select></label>
    <label className="inline"><input type="checkbox" checked={value.preserveBaselineSuccess} onChange={e => onChange({ ...value, preserveBaselineSuccess: e.target.checked })} />保留基准成功案例（硬约束）</label>
    <label className="inline"><input type="checkbox" checked={value.requireSignificantImprovement} onChange={e => onChange({ ...value, requireSignificantImprovement: e.target.checked })} />要求统计显著改善（Holm α=.05）</label>
  </div>;
}
const DEFAULT_REQ: Req = { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 };

export function Requirements() {
  const c = useApp();
  const { project, route } = c;
  const creating = !project || route.params.get("new") === "1";
  const [title, setTitle] = useState("SmolVLA 相机布局设计评审");
  const [decision, setDecision] = useState("判断相机偏移是否可以保留基准成功样本，并定位需回退的失败案例。");
  const [req, setReq] = useState<Req>(DEFAULT_REQ);
  const [revising, setRevising] = useState(false);
  const [draft, setDraft] = useState<Req>(project?.requirements ?? DEFAULT_REQ);
  const prefill = route.params.get("criteria");
  const [criteriaPrefill, setCriteriaPrefill] = useState<FactoryCriteriaValues>();
  useEffect(() => { if (prefill) { try { setCriteriaPrefill(JSON.parse(prefill)); } catch { /* ignore malformed deep link */ } } }, [prefill]);
  useEffect(() => { setDraft(project?.requirements ?? DEFAULT_REQ); setRevising(false); }, [project?.id, project?.revision]);

  const create = (e: FormEvent) => { e.preventDefault(); void c.perform(async () => {
    const p = await api<Project>("/projects", { title, intendedDecision: decision, requirements: req });
    c.selectProject(p.id); c.navigate("overview");
  }, "任务和验收要求已冻结为版本 1。"); };
  const revise = (e: FormEvent) => { e.preventDefault(); void c.perform(async () => {
    await api(`/projects/${project!.id}`, { title: project!.title, intendedDecision: project!.intendedDecision, requirements: draft, expectedRevision: project!.revision }, "PATCH");
    setRevising(false);
  }, `需求已修订为 v${project!.revision + 1}；已有检查继续绑定旧版本。`); };

  if (creating) return <>
    <ViewHeader step="阶段 1 / 6 · 需求冻结" title="新建评审任务" description="创建即冻结需求 v1。之后所有候选、检查和反馈都绑定这一版本与其哈希。" />
    <Card><form className="stack" onSubmit={create}>
      <div className="field-grid two"><label>任务名称<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>准备作出的决策<textarea required minLength={5} rows={3} value={decision} onChange={e => setDecision(e.target.value)} /></label></div>
      <RequirementFields value={req} onChange={setReq} />
      <div className="form-foot"><small>修改需求只能生成新版本，不会改写已有结论。</small>
        <div className="button-row">{project && <button type="button" className="secondary" onClick={() => c.navigate("requirements")}>取消</button>}
          <button type="submit" disabled={c.busy}>创建评审任务</button></div></div>
    </form></Card>
  </>;

  const l = c.lifecycle, criteria = (c.data.factoryCriteria ?? []).filter(x => x.projectId === project.id);
  const r = project.requirements;
  return <>
    <ViewHeader step="阶段 1 / 6 · 需求冻结" title="冻结的验收需求" description="需求与标准先于证据冻结；放宽只能生成新版本，旧版本下的结论与失败案例保持不变。"
      actions={<button type="button" className="secondary" onClick={() => c.navigate("requirements", { new: "1" })}>新建任务</button>} />
    <Card title={<>需求 v{project.revision} <Chip tone="ok">已冻结</Chip></>} aside={<code className="digest">SHA-256 {l?.requirementDigest.slice(0, 16)}…</code>}>
      <dl className="kv">
        <div><dt>准备作出的决策</dt><dd>{project.intendedDecision}</dd></div>
        <div><dt>样本最低成功率</dt><dd>{r.minSuccessRate * 100}%</dd></div>
        <div><dt>保留基准成功案例</dt><dd>{r.preserveBaselineSuccess ? "是（硬约束）" : "否"}</dd></div>
        <div><dt>统计显著改善</dt><dd>{r.requireSignificantImprovement ? `要求（Holm α=${r.alpha}）` : "不要求"}</dd></div>
        <div><dt>创建时间</dt><dd>{time(project.createdAt)}</dd></div>
      </dl>
      {revising ? <form className="stack revise" onSubmit={revise}>
        <RequirementFields value={draft} onChange={setDraft} />
        <p className="warning">保存后生成 v{project.revision + 1}：已有检查仍绑定 v{project.revision}，需要重新执行检查；进行中的反馈可能因需求变化而无法关闭。</p>
        <div className="button-row"><button type="button" className="secondary" onClick={() => setRevising(false)}>取消</button><button type="submit" disabled={c.busy}>保存为 v{project.revision + 1}</button></div>
      </form> : <div className="form-foot"><small>比较-交换更新：若他人已修改，会提示重新加载。</small><button type="button" className="secondary" onClick={() => setRevising(true)}>修订需求</button></div>}
    </Card>
    <Card title="工厂孪生验收标准" aside={<small>{criteria.length} 个版本</small>} id="factory-criteria">
      {criteria.length > 0 && <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">冻结时间</th><th scope="col">需求</th><th scope="col">产出损失 ≤</th><th scope="col">EV ≥</th><th scope="col">车间 ≤</th><th scope="col">摘要</th></tr></thead>
        <tbody>{[...criteria].reverse().map(x => <tr key={x.id}><td>{time(x.createdAt)}</td><td>v{x.projectRevision}</td><td>{x.criteria.maxOutputLossPerSeed}</td>
          <td>{Math.round(x.criteria.minEvServiceRatio * 100)}%</td><td>{x.criteria.maxHallC} °C</td><td><code>{x.digest.slice(0, 8)}</code></td></tr>)}</tbody></table></div>}
      <FactoryCriteriaForm prefill={criteriaPrefill} onFrozen={() => c.navigate("design", { lane: "factory" })} />
    </Card>
  </>;
}
