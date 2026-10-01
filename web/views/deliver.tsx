import { useState } from "react";
import { api } from "../api";
import { KIND_LABEL, useApp } from "../context";
import { Card, Empty, ViewHeader, projectRuns, time, verdictOf } from "../ui";
import type { Campaign } from "../../src/contracts";
import { ReleasePanel } from "./release";

const CHANNELS = [["direct-pilot", "直接试用"], ["github", "GitHub"], ["hugging-face", "Hugging Face"], ["website", "网站"], ["bilibili", "Bilibili"], ["youtube", "YouTube"]] as const;

export function Deliver() {
  const c = useApp();
  const { project } = c;
  const runs = projectRuns(c.data, project?.id).filter(r => r.state === "completed");
  const robots = runs.filter(r => r.kind === "robot-review");
  const [bundleRun, setBundleRun] = useState("");
  const [evidenceRun, setEvidenceRun] = useState("");
  const [channel, setChannel] = useState<string>("direct-pilot");
  const [verified, setVerified] = useState("");
  const [participant, setParticipant] = useState("local-maintainer");
  const [actor, setActor] = useState<"maintainer" | "independent" | "fixture">("maintainer");
  const [eventKind, setEventKind] = useState("started");
  const campaigns = c.data.campaigns.filter(x => x.projectId === project?.id);
  const [campaignId, setCampaignId] = useState("");
  const campaign = campaigns.find(x => x.id === campaignId) ?? campaigns.at(-1);
  const header = <ViewHeader step="阶段 6 / 6 · 发布交付" title="发布与交付" description="发布候选经准入检查与维护者批准后才算采用；交付包可在另一台机器重新核验；案例草稿保留失败与范围限制。工作台不对外发送或发布。" />;
  if (!project) return <>{header}<Empty title="先冻结需求" action={<button type="button" onClick={() => c.navigate("requirements", { new: "1" })}>新建评审任务</button>} /></>;
  if (runs.length === 0) return <>{header}<ReleasePanel /></>;
  const bundle = robots.find(r => r.id === bundleRun) ?? robots[0];
  const evidence = runs.find(r => r.id === evidenceRun) ?? runs[0];
  const m = c.data.metrics;
  return <>
    {header}
    <ReleasePanel />
    <div className="split">
      <Card title="证据交付包" aside={<small>8 个文件 · 哈希与语义核验</small>}>
        {bundle ? <>
          <label>交付记录<select aria-label="选择交付记录" value={bundle.id} onChange={e => setBundleRun(e.target.value)}>{robots.map(r => <option key={r.id} value={r.id}>{r.title} · {verdictOf(r.kind, r.verdict, r.state).label} · {time(r.createdAt)}</option>)}</select></label>
          <div className="button-row"><a className="button secondary" href={`/api/runs/${bundle.id}/bundle`}>下载完整证据包</a></div>
        </> : <p className="muted">机器人记录评审完成后可下载证据包；Blender 与工厂证据在“失败回放”中下载原生文件。</p>}
        <label className="file">验证下载的包<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void c.perform(async () => {
          const r = await api<{ valid: boolean; files: number }>("/bundles/verify", JSON.parse(await file.text()));
          setVerified(`${r.files} 个文件通过完整性与语义对照；来源认证与物理验证尚未建立。`);
        }, "交付包验证完成。"); }} /></label>
        {verified && <p role="status" className="ok-text">{verified}</p>}
      </Card>
      <Card title="案例草稿" aside={<small>草稿 · 不自动发送</small>}>
        <div className="field-grid two">
          <label>证据<select aria-label="选择案例证据" value={evidence.id} onChange={e => setEvidenceRun(e.target.value)}>{runs.map(r => <option key={r.id} value={r.id}>{KIND_LABEL[r.kind]} · {r.title} · {verdictOf(r.kind, r.verdict, r.state).label}</option>)}</select></label>
          <label>渠道<select value={channel} onChange={e => setChannel(e.target.value)}>{CHANNELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        </div>
        <div className="button-row"><button type="button" disabled={c.busy} onClick={() => void c.perform(async () => {
          const created = await api<Campaign>("/campaigns", { runId: evidence.id, evidenceKind: evidence.kind, channel }); setCampaignId(created.id);
        }, "案例草稿已生成，尚未发送。")}>生成案例草稿</button></div>
        {campaign && <details open><summary>{CHANNELS.find(([id]) => id === campaign.channel)?.[1]} · {time(campaign.createdAt)}</summary><pre>{campaign.text}</pre>
          <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(campaign.text).then(() => c.toast("草稿已复制。"))}>复制草稿</button></details>}
      </Card>
    </div>
    <Card title="试用观察" aside={<small>没有曝光分母时不计算转化率</small>}>
      <div className="metrics"><div><span>独立试用者（自报）</span><strong>{m.independentParticipants}</strong></div><div><span>独立再次使用者</span><strong>{m.independentRepeatUsers}</strong></div>
        <div><span>维护者测试事件</span><strong>{m.maintainerEvents}</strong></div></div>
      {campaign ? <div className="field-grid four">
        <label>草稿<select value={campaign.id} onChange={e => setCampaignId(e.target.value)}>{campaigns.map(x => <option key={x.id} value={x.id}>{x.channel} · {time(x.createdAt)}</option>)}</select></label>
        <label>匿名参与者标识<input value={participant} onChange={e => setParticipant(e.target.value)} /></label>
        <label>参与者类型<select value={actor} onChange={e => setActor(e.target.value as typeof actor)}><option value="maintainer">维护者测试</option><option value="independent">独立参与者（自报）</option><option value="fixture">自动测试</option></select></label>
        <label>实际观察事件<select value={eventKind} onChange={e => setEventKind(e.target.value)}><option value="started">开始试用</option><option value="completed">完成试用</option><option value="evidence-reopened">重新打开证据</option><option value="feedback">提供反馈</option><option value="repeat-use">再次使用</option></select></label>
        <div className="button-row end span"><button type="button" disabled={c.busy} onClick={() => void c.perform(() => api("/events", { eventId: crypto.randomUUID(), campaignId: campaign.id, participantId: participant, actorKind: actor, kind: eventKind }), "观察事件已保存。")}>记录实际事件</button></div>
      </div> : <p className="muted">先生成案例草稿，再记录实际发生的试用事件。试用中的问题回到“反馈复测”，绑定证据后复测。</p>}
    </Card>
  </>;
}
