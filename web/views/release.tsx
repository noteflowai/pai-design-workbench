import { useEffect, useState } from "react";
import { api, requestIdFor } from "../api";
import { ADMISSION_LABELS, KIND_LABEL, MATURITY, useApp, type RunKind } from "../context";
import { Card, Check, Chip, Empty, projectRuns, time, verdictOf } from "../ui";
import type { AdmissionCheck, Release } from "../../src/release";

const PASSING = new Set(["accepted-in-recorded-panel", "accepted-static-scene", "accepted-cad-part", "accepted-illustrative"]);

/** Release candidate → server-computed admission → maintainer approval, as in PDM release management. */
export function ReleasePanel() {
  const c = useApp();
  const p = c.project!;
  const releases = (c.data.releases ?? []).filter(r => r.projectId === p.id).slice().reverse();
  const pending = releases.find(r => r.maturity === "in-review"), current = releases.find(r => r.maturity === "released");
  const passing = projectRuns(c.data, p.id).filter(r => r.state === "completed" && r.verdict && PASSING.has(r.verdict) && r.revision === p.revision);
  const [runId, setRunId] = useState("");
  const run = passing.find(r => r.id === runId) ?? passing[0];
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("准入检查全部通过；在所述证据范围内采用此设计决策。");
  const [checks, setChecks] = useState<AdmissionCheck[]>();
  useEffect(() => { setTitle(run ? `${p.title} · ${run.title}` : ""); }, [run?.id, p.title]);
  useEffect(() => {
    let live = true; setChecks(undefined);
    if (run) void api<AdmissionCheck[]>(`/projects/${p.id}/admission?kind=${run.kind}&runId=${run.id}`).then(x => { if (live) setChecks(x); }).catch(() => undefined);
    return () => { live = false; };
  }, [run?.id, p.id, p.revision, c.data.feedback.length, c.data.feedback.map(f => f.status).join()]);
  const admissible = Boolean(checks?.length && checks.every(x => x.passed));
  const [verified, setVerified] = useState<Record<string, { ok: boolean; text: string }>>({});
  // Fetch the package as a third party would and verify it against the separately published public key.
  const verifyRelease = async (id: string) => {
    try {
      const [pkg, key] = await Promise.all([fetch(`/api/releases/${id}/package`).then(r => r.json()), api<{ publicKeyPem: string }>("/signing/public-key")]);
      const v = await api<{ files: number; signer: { trusted: boolean; algorithm: string; keyId: string } }>("/packages/verify", { package: pkg, trustedPublicKeyPem: key.publicKeyPem });
      setVerified(x => ({ ...x, [id]: { ok: v.signer.trusted, text: `签名有效 · ${v.signer.algorithm === "ECDSA_P256_SHA256" ? "AWS KMS ECDSA P-256" : "本机 Ed25519"} · ${v.files} 个原生文件摘要一致 · 签名者已固定` } }));
    } catch (e) { setVerified(x => ({ ...x, [id]: { ok: false, text: `核验失败：${e instanceof Error ? e.message : String(e)}` } })); }
  };
  const decide = (r: Release, decision: "approve" | "reject") => c.perform(() => api(`/projects/${p.id}/releases/${r.id}`,
    { expectedRevision: r.revision, decision, reason }, "PATCH"), decision === "approve" ? `${r.number} 已批准发布。` : `${r.number} 已驳回。`);

  return <Card title={<>发布与成熟度 {current ? <Chip tone="ok">{current.number} 已发布</Chip> : pending ? <Chip tone="warn">{pending.number} 待审批</Chip> : <Chip>未发布</Chip>}</>}
    aside={<small>发布 = 在证据范围内采用此决策；不是物理验证或量产放行</small>} id="release" label="发布与成熟度">
    {pending ? <div className="stack">
      <div className="release-head"><strong>{pending.number} · {pending.title}</strong><small>{KIND_LABEL[pending.evidenceKind as RunKind]} · 需求 v{pending.projectRevision} · {time(pending.createdAt)}</small></div>
      <ul className="checks flat">{pending.admission.map(x => <Check key={x.id} passed={x.passed} title={ADMISSION_LABELS[x.id] ?? x.id} detail={x.detail} />)}</ul>
      <p className="muted">证据范围：{pending.scope}。批准时服务器会重新检查准入条件。</p>
      <label>审批说明<textarea rows={2} minLength={5} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="button-row end"><button type="button" className="secondary" disabled={c.busy || reason.trim().length < 5} onClick={() => void decide(pending, "reject")}>驳回</button>
        <button type="button" disabled={c.busy || reason.trim().length < 5} onClick={() => void decide(pending, "approve")}>批准发布 {pending.number}</button></div>
    </div> : passing.length === 0 ? <Empty title="还没有可发布的检查" action={<button type="button" onClick={() => c.navigate("design")}>提交候选</button>}>
      发布需要一次绑定当前需求 v{p.revision}、结论为通过的原生检查。拒绝的检查保留为失败案例，经反馈复测后可以用复测记录发布。</Empty>
    : <form className="stack" onSubmit={e => { e.preventDefault(); void c.perform(() => api(`/projects/${p.id}/releases`, { requestId: requestIdFor(`pai-release-${p.id}-${p.revision}-${run!.id}`),
        projectRevision: p.revision, evidenceKind: run!.kind, runId: run!.id, title, notes }), "发布候选已创建，等待审批。"); }}>
      <div className="field-grid two">
        <label>发布依据的检查<select aria-label="发布依据的检查" value={run!.id} onChange={e => setRunId(e.target.value)}>{passing.map(r =>
          <option key={r.id} value={r.id}>{KIND_LABEL[r.kind]} · {r.title} · {verdictOf(r.kind, r.verdict, r.state).label}{r.recheck ? " · 复测" : ""} · {time(r.createdAt)}</option>)}</select></label>
        <label>发布标题<input required minLength={2} maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>
      </div>
      <label>说明（可选）<textarea rows={2} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="admission" aria-label="发布准入检查">
        <p className="eyebrow">准入检查</p>
        {checks ? <ul className="checks flat">{checks.map(x => <Check key={x.id} passed={x.passed} title={ADMISSION_LABELS[x.id] ?? x.id} detail={x.detail} />)}</ul> : <p className="muted">正在检查…</p>}
        {checks && !admissible && <div className="button-row">{checks.some(x => !x.passed && ["failures-dispositioned", "no-open-feedback"].includes(x.id)) &&
          <button type="button" className="secondary" onClick={() => c.navigate("feedback")}>处理反馈</button>}</div>}
      </div>
      <div className="form-foot"><small>候选需要维护者批准；同一时间只能有一个待审批候选。</small><button type="submit" disabled={c.busy || !admissible || title.trim().length < 2}>创建发布候选</button></div>
    </form>}
    {releases.length > 0 && <div className="table-wrap release-history"><table className="data-table"><caption className="visually-hidden">发布历史</caption>
      <thead><tr><th scope="col">编号</th><th scope="col">标题</th><th scope="col">成熟度</th><th scope="col">需求</th><th scope="col">最后变更</th></tr></thead>
      <tbody>{releases.map(r => { const [label, tone] = MATURITY[r.maturity]; const last = r.history.at(-1)!;
        return <tr key={r.id}><td><strong>{r.number}</strong></td><td>{r.title}<small>{KIND_LABEL[r.evidenceKind as RunKind]}</small></td><td><Chip tone={tone}>{label}</Chip></td>
          <td>v{r.projectRevision}</td><td>{time(last.at)}<small>{last.reason}</small>
          {r.maturity === "released" && <span className="button-row"><a className="button secondary compact" href={`/api/releases/${r.id}/package`} download>下载签名发布包</a>
            <button type="button" className="secondary compact" onClick={() => void verifyRelease(r.id)}>核验签名</button></span>}
          {verified[r.id] && <small className={verified[r.id].ok ? "ok-text" : "bad-text"} role="status">{verified[r.id].text}</small>}</td></tr>; })}</tbody></table></div>}
    {current && <p className="muted">签名发布包含证据记录、经摘要核验的原生文件（STEP、FEA、MJCF、.blend…）与审批记录；清单由{c.data.capabilities.signing?.kms ? " AWS KMS 密钥" : "本机 Ed25519 密钥"}签名，可离线用 <code>npm run verify:package</code> 核验。</p>}
  </Card>;
}
