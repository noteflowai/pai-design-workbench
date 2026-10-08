import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Card, Check, Chip, Empty, ViewHeader, time, type Tone } from "../ui";
import type { ArtifactVersion } from "../../src/artifacts/registry";
import type { Workflow, WorkflowRun } from "../../src/artifacts/workflows";

/** Workspace-level: the artifact registry (algorithms/models) and configurable business workflows over them. */
type Summary = { id: string; title: string; kind: string; state: ArtifactVersion["state"]; digest: string; origin: string; validated: { at: string; passed: boolean } | null };
const STATE: Record<string, [string, Tone]> = { draft: ["草稿", "muted"], validated: ["已验收", "info"], released: ["已发布", "ok"], deprecated: ["已弃用", "warn"] };
const RUN: Record<string, [string, Tone]> = { running: ["运行中", "live"], "waiting-approval": ["待人工确认", "warn"], succeeded: ["完成", "ok"], rejected: ["已拒绝", "bad"],
  failed: ["失败", "bad"], interrupted: ["已中断", "warn"] };
const NODE: Record<string, [string, Tone]> = { pending: ["未执行", "muted"], running: ["运行中", "live"], succeeded: ["完成", "ok"], failed: ["失败", "bad"],
  "waiting-approval": ["待确认", "warn"], rejected: ["拒绝", "bad"], skipped: ["跳过", "muted"] };
const CHECK: Record<string, string> = { "routes-continuous": "路线连续（从车场出发并返回）", "each-order-once": "每单恰好一次", "pickup-before-delivery": "先取后送、同一辆车",
  capacity: "载重不超限", "time-windows": "时间窗与班次", "reported-figures": "里程与成本复算一致", "status-consistent": "状态与计划一致" };
const DEFAULT_WORKFLOW = (ref: string) => ({
  schema: "pai-workflow-1", name: "offsite-delivery-plan", version: 1, title: "场外配送计划：求解 → 独立核验 → 调度员确认",
  inputs: { problem: { schema: "pai-logistics-problem-1" } },
  nodes: [
    { id: "solve", type: "artifact", artifact: ref, operation: "solve", inputs: { problem: "$input.problem" }, params: { strategy: "deterministic", timeLimitSeconds: 10 } },
    { id: "verify", type: "artifact", artifact: ref, operation: "verify", inputs: { problem: "$input.problem", plan: "$solve.plan" } },
    { id: "gate", type: "condition", status: "$verify", pass: ["feasible-plan"] },
    { id: "dispatcher", type: "approval", prompt: "调度员确认计划后才可交付（不会自动派车）", after: ["gate"] },
  ],
  outputs: { plan: "$solve.plan", verification: "$verify.verification" },
});
const download = (name: string, value: unknown) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

export function Artifacts() {
  const c = useApp();
  const [artifacts, setArtifacts] = useState<Summary[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [version, setVersion] = useState("1.0.0");
  const [definition, setDefinition] = useState("");
  const [check, setCheck] = useState<{ valid: boolean; message?: string; order?: string[] }>();
  const [verified, setVerified] = useState<{ valid: boolean; artifact?: string; error?: string; message?: string }>();
  const [workflowId, setWorkflowId] = useState("");
  const [scenario, setScenario] = useState("normal");
  const [seed, setSeed] = useState(11);
  const load = useCallback(async () => {
    const [a, w, r] = await Promise.all([api<{ artifacts: Summary[] }>("/v1/artifacts"), api<Workflow[]>("/v1/workflows"), api<WorkflowRun[]>("/v1/workflow-runs")]);
    setArtifacts(a.artifacts); setWorkflows(w); setRuns(r);
    return a.artifacts;
  }, []);
  useEffect(() => { void load().then(a => {
    const usable = a.find(x => x.state === "released") ?? a.find(x => x.state === "validated") ?? a[0];
    setDefinition(d => d || JSON.stringify(DEFAULT_WORKFLOW(usable?.id ?? `logistics-pdptw@1.0.0`), null, 2));
  }).catch(e => c.toast(String(e), "bad")); }, [load]);
  const act = (f: () => Promise<unknown>, message: string) => c.perform(async () => { await f(); await load(); }, message);
  const reason = (label: string) => { const r = prompt(label)?.trim(); if (!r || r.length < 5) { c.toast("需要至少 5 个字的理由。", "bad"); return undefined; } return r; };
  const selected = workflows.find(w => w.id === workflowId) ?? workflows.at(-1);

  return <>
    <ViewHeader step="工作区 · 制品与编排" title="制品库与流程编排"
      description="交付的是可独立核验的制品：算法和模型按不可变版本登记，经自身基准验收、人工发布后才能被流程使用；流程用 JSON 配置，引用精确版本，每个节点记录产物、证据与用量。示例全部是合成数据。" />
    <Card title="制品库" aside={<small>{artifacts.length} 个版本 · 名称@语义版本 · 摘要即身份</small>} label="制品库">
      <div className="field-grid two">
        <label>从可信源构建 logistics-pdptw 版本<input value={version} onChange={e => setVersion(e.target.value)} inputMode="decimal" pattern="\d+\.\d+\.\d+" /></label>
        <div className="button-row"><button type="button" disabled={c.busy} onClick={() => void act(() => api("/v1/artifacts", { adapter: "logistics-pdptw", version }), "制品版本已登记为草稿。")}>构建草稿</button></div>
      </div>
      {artifacts.length === 0 ? <Empty title="还没有制品">构建第一个制品：场外物流规划（OR-Tools 取送货车辆路径）。</Empty> :
        <ul className="artifact-list" aria-label="制品版本">{artifacts.map(a => <li key={a.id}>
          <div className="artifact-id"><strong>{a.id}</strong> <Chip tone={STATE[a.state][1]}>{STATE[a.state][0]}</Chip>{a.validated && !a.validated.passed && <Chip tone="bad">基准未通过</Chip>}
            <small>{a.kind === "algorithm" ? "算法" : "模型"} · {a.title}{a.origin === "imported" ? " · 导入" : ""} · <code>{a.digest.slice(0, 12)}</code></small></div>
          <div className="button-row">
            {a.state === "draft" && <button type="button" className="secondary compact" disabled={c.busy} onClick={() => void act(() => api(`/v1/artifacts/${a.id}/validation`, {}), "基准验收完成。")}>运行验收基准</button>}
            {a.state === "validated" && <button type="button" className="secondary compact" disabled={c.busy} onClick={() => { const r = reason("发布理由"); if (r) void act(() => api(`/v1/artifacts/${a.id}/lifecycle`, { to: "released", reason: r }), "已发布。"); }}>发布</button>}
            {(a.state === "validated" || a.state === "released") && <>
              <button type="button" className="secondary compact" disabled={c.busy} onClick={() => void c.perform(async () => download(`pai-artifact-${a.id.replace("@", "-")}.json`, await api(`/v1/artifacts/${a.id}/package`)), "签名制品包已下载。")}>下载签名包</button>
              <button type="button" className="ghost compact" disabled={c.busy} onClick={() => { const r = reason("弃用理由"); if (r) void act(() => api(`/v1/artifacts/${a.id}/lifecycle`, { to: "deprecated", reason: r }), "已弃用；已有流程版本需改用新版本。"); }}>弃用</button></>}
          </div></li>)}</ul>}
      <label className="file">核验或导入签名制品包<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void c.perform(async () => {
        const pkg = JSON.parse(await file.text());
        const r = await api<{ valid: boolean; artifact?: string; error?: string; message?: string }>("/v1/artifact-packages/verification", { package: pkg });
        setVerified(r);
        if (r.valid && confirm(`签名与 ${r.artifact} 的全部文件摘要一致。导入为草稿？（代码须与本版本可信源逐字节一致）`)) { await api("/v1/artifact-packages", pkg); await load(); }
      }, "制品包核验完成。"); e.target.value = ""; }} /></label>
      {verified && <p role="status" className={verified.valid ? "ok-text" : "bad-text"}>{verified.valid ? `签名有效：${verified.artifact}` : `已拒绝（${verified.error}）：${verified.message}`}</p>}
    </Card>

    <Card title="流程配置" aside={<small>pai-workflow-1 · 节点引用精确版本 · 保存后不可改</small>} label="流程配置">
      <label className="code-editor">流程定义（JSON）<textarea aria-label="流程定义 JSON" value={definition} onChange={e => { setDefinition(e.target.value); setCheck(undefined); }} spellCheck={false} /></label>
      <div className="button-row">
        <button type="button" className="secondary" disabled={c.busy} onClick={() => void c.perform(async () => {
          let body: unknown; try { body = JSON.parse(definition); } catch { setCheck({ valid: false, message: "不是合法 JSON" }); return; }
          setCheck(await api("/v1/workflow-validation", body));
        }, "流程已校验。")}>校验</button>
        <button type="button" disabled={c.busy} onClick={() => void act(async () => { const w = await api<Workflow>("/v1/workflows", JSON.parse(definition)); setWorkflowId(w.id); }, "流程版本已保存。")}>保存流程版本</button>
      </div>
      {check && <p role="status" className={check.valid ? "ok-text" : "bad-text"}>{check.valid ? `结构、类型与依赖检查通过；执行顺序 ${check.order?.join(" → ")}` : `未通过：${check.message}`}</p>}
    </Card>

    <Card title="运行" aside={<small>不自动重试 · 原生用量与模型 Token 分开记录</small>} label="流程运行">
      {workflows.length === 0 ? <Empty title="先保存一个流程版本" /> : <>
        <div className="field-grid">
          <label>流程<select value={selected?.id ?? ""} onChange={e => setWorkflowId(e.target.value)}>{workflows.map(w => <option key={w.id} value={w.id}>{w.id} · {w.definition.title}</option>)}</select></label>
          <label>合成实例<select value={scenario} onChange={e => setScenario(e.target.value)}>
            <option value="normal">常规（40 单 / 8 车）</option><option value="tight">收窄送货时间窗</option><option value="overload">单票超重 9 t</option></select></label>
          <label>种子<input type="number" value={seed} min={0} onChange={e => setSeed(Number(e.target.value))} /></label>
        </div>
        <div className="button-row"><button type="button" disabled={c.busy || !selected} onClick={() => void act(async () => {
          const ref = selected!.definition.nodes.find(n => n.type === "artifact") as { artifact: string } | undefined;
          const problem = await api(`/v1/artifacts/${ref!.artifact}/samples`, { scenario, seed });
          await api("/v1/workflow-runs", { requestId: crypto.randomUUID(), workflow: selected!.id, inputs: { problem } });
        }, "流程已运行，结果见下方。")}>用合成实例运行</button></div>
      </>}
      {runs.map(r => <RunCard key={r.id} run={r} onChange={load} reason={reason} />)}
    </Card>
  </>;
}

function RunCard({ run, onChange, reason }: { run: WorkflowRun; onChange: () => Promise<unknown>; reason: (l: string) => string | undefined }) {
  const c = useApp();
  const [plan, setPlan] = useState<{ status: string; totalDistanceKm: number; totalCost: number; vehiclesUsed: number; unassigned: string[]; routes: { vehicle: string; stops: unknown[]; distanceKm: number }[] }>();
  const [checks, setChecks] = useState<{ id: string; passed: boolean; detail?: string[] }[]>();
  useEffect(() => {
    if (!run.nodes.solve?.outputs?.plan) return;
    void api<NonNullable<typeof plan>>(`/v1/workflow-runs/${run.id}/data?node=solve&name=plan`).then(setPlan).catch(() => undefined);
    if (run.nodes.verify?.outputs?.verification) void api<{ checks: NonNullable<typeof checks> }>(`/v1/workflow-runs/${run.id}/data?node=verify&name=verification`).then(v => setChecks(v.checks)).catch(() => undefined);
  }, [run.id, run.revision]);
  const waiting = Object.entries(run.nodes).find(([, n]) => n.state === "waiting-approval")?.[0];
  return <details className="receipts run-detail" open={run.state === "waiting-approval"}>
    <summary><Chip tone={RUN[run.state][1]}>{RUN[run.state][0]}</Chip> {run.workflowId} · {time(run.createdAt)}{plan && ` · ${plan.status}${typeof plan.totalDistanceKm === "number" ? ` · ${plan.totalDistanceKm} km` : ""}`}</summary>
    {run.error && <p className="bad-text">原因：{run.error}</p>}
    <div className="table-wrap"><table className="data-table nodes"><caption className="visually-hidden">节点</caption>
      <thead><tr><th scope="col">节点</th><th scope="col">状态</th><th scope="col">结果</th><th scope="col">墙钟 / CPU s</th><th scope="col">存储</th><th scope="col">模型 Token</th></tr></thead>
      <tbody>{Object.entries(run.nodes).map(([id, n]) => <tr key={id}><th scope="row">{id}</th><td><Chip tone={NODE[n.state][1]}>{NODE[n.state][0]}</Chip></td><td>{n.status ?? "—"}{n.error && <><br /><small className="bad-text">{n.error}</small></>}</td>
        <td>{n.usage ? `${n.usage.native.wallSeconds} / ${n.usage.native.cpuSeconds ?? "unknown"}` : "—"}</td><td>{n.usage ? `${(n.usage.native.storageBytes / 1024).toFixed(1)} KB` : "—"}</td>
        <td>{n.usage ? n.usage.model.status === "none" ? "无模型调用" : n.usage.model.status === "unknown" ? "unknown" : `${n.usage.model.inputTokens} / ${n.usage.model.outputTokens}` : "—"}</td></tr>)}</tbody></table></div>
    {checks && <ul className="checks" aria-label="独立核验">{checks.map(k => <Check key={k.id} passed={k.passed} title={CHECK[k.id] ?? k.id} detail={k.detail?.length ? k.detail.slice(0, 3).join("；") : "独立复算一致"} />)}</ul>}
    {plan && plan.routes.length > 0 && <p className="muted">{plan.vehiclesUsed} 辆车 · 成本 {plan.totalCost}{plan.unassigned.length ? ` · ${plan.unassigned.length} 单未分配` : ""} · {plan.routes.map(r => `${r.vehicle} ${r.stops.length} 站 ${r.distanceKm} km`).join("；")}</p>}
    {waiting && <div className="button-row">
      <button type="button" disabled={c.busy} onClick={() => { const r = reason("确认理由（记录在运行里）"); if (r) void c.perform(async () => { await api(`/v1/workflow-runs/${run.id}/decisions`, { node: waiting, approve: true, reason: r }); await onChange(); }, "已确认，流程继续。"); }}>确认 {waiting}</button>
      <button type="button" className="secondary" disabled={c.busy} onClick={() => { const r = reason("拒绝理由"); if (r) void c.perform(async () => { await api(`/v1/workflow-runs/${run.id}/decisions`, { node: waiting, approve: false, reason: r }); await onChange(); }, "已拒绝，流程结束。"); }}>拒绝</button>
    </div>}
    {run.state === "interrupted" && <button type="button" className="secondary" onClick={() => void c.perform(async () => { await api(`/v1/workflow-runs/${run.id}/resume`, {}); await onChange(); }, "已恢复（仅无外部副作用的节点）。")}>恢复</button>}
  </details>;
}
