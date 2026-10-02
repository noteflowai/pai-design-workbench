import { lazy, Suspense, useEffect, useState } from "react";
import { CANDIDATES, KIND_LABEL, useApp, type RunKind } from "../context";
import { Card, Check, Chip, Empty, ViewHeader, Verdict, projectRuns, revealInScroller, time, verdictOf, type RunItem } from "../ui";
import { LiveSteps, viewportModel } from "../studio";
import { FactoryResult } from "../factory";
import { recordCaseFeedback } from "../actions";
import { FEEDBACK_STATUS } from "../context";
import type { Review } from "../../src/contracts";
import type { SceneReview } from "../../src/scenes";
import type { CadReview } from "../../src/cad";
import { CAD_CHECK_LABELS, CAD_VARIANTS, ISOLATION_LABEL } from "../context";
import { CheckTable, type MeasuredCheck } from "../ui";
import { CompareCandidates } from "./compare";

const Viewport = lazy(() => import("../viewport"));

export function CaseList({ runId }: { runId: string }) {
  const c = useApp();
  const cases = (c.lifecycle?.failingCases ?? []).filter(x => x.runId === runId);
  if (!cases.length) return null;
  return <Card title="保留的失败案例" aside={<small>失败案例须绑定反馈并复测</small>}>
    <ul className="cases">{cases.map(fc => <li key={`${fc.checkId ?? ""}-${fc.seed}`}>
      <span className="case-label">{fc.label}</span>
      <span className="case-actions">
        {fc.kind === "robot-review" && <button type="button" className="secondary" onClick={() => c.navigate("evidence", { kind: fc.kind, id: fc.runId, seed: String(fc.seed) })}>回放</button>}
        {fc.feedbackId ? <button type="button" className="link" onClick={() => c.navigate("feedback", { id: fc.feedbackId })}><Chip tone={fc.feedbackStatus === "closed" ? "ok" : "warn"}>反馈 · {FEEDBACK_STATUS[fc.feedbackStatus!]}</Chip></button>
          : <button type="button" disabled={c.busy} aria-label={`记录反馈：${fc.label}`} onClick={() => void recordCaseFeedback(c, fc)}>记录反馈</button>}
      </span></li>)}</ul>
  </Card>;
}

function Receipts({ value }: { value: unknown }) {
  return <details className="receipts"><summary>原生回执与来源指纹</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function robotDetail(run: Review, id: string, passed: boolean | null): string {
  const r = run.project.requirements, c = run.stress?.conditions.find(x => x.id === run.candidate);
  const t = run.stress?.paired_exact_test.comparisons.find(x => x.condition === run.candidate);
  if (id === "minimum-recorded-success") return `记录成功 ${c?.successes ?? "—"}/${c?.trials ?? "—"}；要求不低于 ${r.minSuccessRate * 100}%`;
  if (id === "preserve-baseline-success") return passed === null ? `丢失 ${run.diff?.blocking_changes ?? "—"} 个基准成功样本；本任务未要求保留` : `EvalArc 检测到丢失 ${run.diff?.blocking_changes ?? "—"} 个基准成功样本`;
  return t ? `Holm 调整 p=${t.holm_adjusted_p}，α=${r.alpha}；${passed === null ? "本任务未要求显著改善" : passed ? "显著改善" : "不支持显著改善"}` : "基准设置不是改善比较";
}
function ReviewDetail({ run }: { run: Review }) {
  const c = useApp();
  const v = verdictOf("robot-review", run.decision?.verdict, run.state);
  const lost = run.diff?.blocking_changes;
  return <>
    <Verdict tone={v.tone} eyebrow={`Robot Reel 记录评审 · ${CANDIDATES[run.candidate]} · 需求 v${run.projectRevision}`} title={v.label}
      detail={run.error ?? (lost ? `配对记录丢失 ${lost} 个基准成功案例；${run.project.requirements.preserveBaselineSuccess ? "当前需求要求保留这些案例。" : "此任务未把保留基准设为硬约束。"}` : "记录检查已保存；结论不外推到真实环境。")} />
    {run.stress && <div className="metrics">{run.stress.conditions.map(x => <div key={x.id} className={x.id === run.candidate ? "current" : ""}>
      <span>{CANDIDATES[x.id]}</span><strong>{x.successes}<small>/{x.trials}</small></strong><p>Wilson 95% {x.wilson95.map(n => `${(n * 100).toFixed(0)}%`).join("–")}</p></div>)}</div>}
    {run.decision && <ul className="checks">{run.decision.checks.map(x => <Check key={x.id} passed={x.passed} detail={robotDetail(run, x.id, x.passed)}
      title={{ "minimum-recorded-success": "最低成功率", "preserve-baseline-success": "基准成功保留", "independent-improvement": "统计改善要求" }[x.id] ?? x.id}
      onAsk={() => c.askAI(`机器人记录评审（${CANDIDATES[run.candidate]}）的检查「${x.id}」未通过：${robotDetail(run, x.id, x.passed)}。为什么？请引用记录，并说明下一步应该复测什么。`)} />)}</ul>}
    <Receipts value={{ request: run.request, requirementDigest: run.requirementDigest, sourceDigests: run.sourceDigests, receipts: run.receipts, controller: run.controller }} />
  </>;
}

const SCENE_CHECK: Record<string, string> = { "footprint-area": "静态占地", "declared-target-envelope": "声明的目标包络", "camera-visibility": "原生相机射线可见性" };
function SceneDetail({ scene }: { scene?: SceneReview }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "blender-scene" && c.session.running;
  const model = viewportModel(c.session, scene, live ? c.session!.current ?? which : which);
  const v = scene ? verdictOf("blender-scene", scene.verdict, scene.state) : { label: "Blender 原生构建中", tone: "live" as const };
  return <>
    <Verdict tone={v.tone} eyebrow={`Blender 原生几何评审${scene ? ` · ${scene.request.variant === "occluded" ? "带遮挡候选" : "无遮挡布局"} · ${scene.candidate?.blenderVersion ?? "Blender"}` : ""}`} title={v.label}
      detail={scene?.error ?? (scene?.state === "completed" ? `EvalArc 检测到 ${scene.diff?.blocking_changes ?? "—"} 项丢失的检查；静态几何结论不外推到动态执行。` : "每完成一个构建阶段，原生几何即推送到视口。")} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={model} /></Suspense>
    <div className="segmented" role="group" aria-label="布局">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "基准布局" : "候选布局"}</button>)}</div>
    {scene?.state === "completed" && <>
      <ul className="checks">{scene.candidate?.checks.map(x => {
        const observed = typeof x.observed === "number" ? x.observed.toFixed(2) : "—", required = typeof x.required === "number" ? x.required.toFixed(2) : "—";
        const hit = x.firstHit === "Target" ? "目标中心" : x.firstHit === "Visibility obstruction" ? "遮挡物" : "其他物体";
        const detail = x.id === "footprint-area" ? `占地 ${observed} m²；允许上限 ${required} m²` : x.id === "declared-target-envelope" ? `目标平面距离 ${observed} m；声明包络半径 ${required} m，不代表关节可达性`
          : `相机射线首先命中${hit}；原生投影与射线检查${x.passed ? "通过" : "失败"}`;
        return <Check key={x.id} passed={x.passed} title={SCENE_CHECK[x.id]} detail={detail}
          onAsk={() => c.askAI(`Blender 场景的「${SCENE_CHECK[x.id]}」未通过（${detail}）。为什么？请引用记录，并给出不放宽需求的布局修正方案。`)} />;
      })}</ul>
      <div className="scene-previews">{(["baseline", "candidate"] as const).map(w => <figure key={w}><img alt={`${w === "baseline" ? "基准" : "候选"}合成工作单元原生 Cycles 渲染`} src={`/api/scenes/${scene.id}/files/${w}/preview.png`} />
        <figcaption>{w === "baseline" ? "基准" : "候选"} · 原生 Cycles 渲染</figcaption></figure>)}</div>
      <Receipts value={{ request: scene.request, requirementDigest: scene.requirementDigest, receipts: scene.receipts, files: scene.files, rays: scene.rays }} />
    </>}
  </>;
}

/** CAD checks as measured rows; margin = share of the allowance left (negative = violated). */
function cadRows(checks: { id: string; passed: boolean; observed?: unknown; required?: unknown }[]): MeasuredCheck[] {
  const num = (v: unknown) => typeof v === "number" ? v : NaN;
  const ge = (o: number, r: number) => r ? (o - r) / r : undefined, le = (o: number, r: number) => r ? (r - o) / r : undefined;
  return checks.map(x => {
    const o = num(x.observed), r = num(x.required), title = CAD_CHECK_LABELS[x.id] ?? x.id;
    if (x.id === "min-wall") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≥ ${r}`, unit: "mm", margin: ge(o, r), note: "板厚与孔间韧带" };
    if (x.id === "hole-edge-distance") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≥ ${r}`, unit: "mm", margin: ge(o, r), note: "1.5×d 经验规则" };
    if (x.id === "mass") return { id: x.id, title, passed: x.passed, observed: String(o), required: `≤ ${r}`, unit: "g", margin: le(o, r), note: "6061 铝名义密度" };
    if (x.id === "motor-interference") return { id: x.id, title, passed: x.passed, observed: String(o), required: "0", unit: "mm³", note: "与电机机体、止口、轴的布尔交集" };
    if (x.id === "envelope") {
      const ob = x.observed as number[], rq = x.required as number[];
      return { id: x.id, title, passed: x.passed, observed: ob.join(" × "), required: `≤ ${rq.join(" × ")}`, unit: "mm", margin: Math.min(...ob.map((v, i) => (rq[i] - v) / rq[i])) };
    }
    if (x.id === "nema17-interface") {
      const v = x.observed as { pilotBore: number; boltHoles: number[]; pitch: number[] };
      return { id: x.id, title, passed: x.passed, observed: `Ø${v.pilotBore} · 4×Ø${v.boltHoles[0] ?? "—"} · ${v.pitch.join("/")}`, required: "≥ Ø22.2 · 4×Ø3.4 · 31", unit: "mm", margin: ge(v.pilotBore, 22.2) };
    }
    return { id: x.id, title, passed: x.passed, observed: String(x.observed), required: "1", unit: "实体", note: "OCCT BRepCheck" };
  });
}
const SANDBOX_STATUS: Record<string, string> = { ok: "已生成实体", policy: "违反代码策略", error: "代码出错", limit: "超出资源上限" };
function CadDetail({ cad }: { cad?: CadReview }) {
  const c = useApp();
  const [which, setWhich] = useState<"baseline" | "candidate">("candidate");
  const live = c.session?.kind === "cad-part" && c.session.running;
  const model = viewportModel(c.session, cad, live ? c.session!.current ?? which : which, "cad-part");
  const v = cad ? verdictOf("cad-part", cad.verdict, cad.state) : { label: "CadQuery 原生建模中", tone: "live" as const };
  const shown = which === "baseline" ? cad?.baseline : cad?.candidate;
  return <>
    <Verdict tone={v.tone} eyebrow={`参数化 CAD · NEMA 17 电机支架${cad ? ` · ${CAD_VARIANTS[cad.request.variant][0]} · CadQuery ${cad.candidate?.cadquery ?? ""}` : ""}`} title={v.label}
      detail={cad?.error ?? (cad?.state === "completed" ? `EvalArc 检测到 ${cad.diff?.blocking_changes ?? "—"} 项丢失的检查；质量 ${cad.baseline?.mass} → ${cad.candidate?.mass} g。名义几何，不含 FEA 或实物测试。` : "每完成一个建模特征，B-Rep 几何即推送到视口；最后叠加 NEMA 17 电机做装配检查。")} />
    <Suspense fallback={<div className="viewport viewport-loading">加载三维视口…</div>}><Viewport model={model} /></Suspense>
    <div className="segmented" role="group" aria-label="零件">{(["baseline", "candidate"] as const).map(w =>
      <button key={w} type="button" aria-pressed={which === w} className={which === w ? "active" : ""} onClick={() => setWhich(w)}>{w === "baseline" ? "基准零件" : "候选零件"}</button>)}</div>
    {cad?.sandbox && <details className="code-source" open={cad.state === "failed"}>
      <summary>生成代码 · {cad.request.source!.code.split("\n").length} 行 · sha256 {cad.sandbox.codeSha256.slice(0, 12)} · 沙箱结果 {SANDBOX_STATUS[cad.sandbox.status] ?? cad.sandbox.status}</summary>
      {cad.sandbox.error && <p className="warning">⚠ {cad.sandbox.error}</p>}
      <p className="muted">{cad.sandbox.transport === "agentcore" ? "运行位置：Amazon Bedrock AgentCore（arm64 microVM）· " : ""}隔离：{cad.sandbox.isolation.map(x => ISOLATION_LABEL[x] ?? x).join(" · ")}
        {cad.sandbox.layers && ` · 实际启用：${Object.entries(cad.sandbox.layers).filter(([, v]) => v).map(([k]) => ({ astPolicy: "AST 策略", processLockdown: "进程锁定", bubblewrap: "bubblewrap", microvm: "microVM" } as Record<string, string>)[k]).join("、")}`}</p>
      <pre className="code">{cad.request.source!.code}</pre>
    </details>}
    {cad?.state === "completed" && shown && <>
      <CheckTable caption={`${which === "baseline" ? "基准" : "候选"}零件 · B-Rep 实测`} rows={cadRows(shown.checks)}
        onAsk={row => c.askAI(`${CAD_VARIANTS[cad.request.variant][0]}零件的「${row.title}」实测 ${row.observed} ${row.unit}，要求 ${row.required} ${row.unit}，为什么未通过？请引用检查记录，并给出在不放宽要求的前提下的修正方案（预设变体或 cad-code）。`)} />
      <div className="scene-previews drawings">{(["baseline", "candidate"] as const).map(w => <figure key={w}><img alt={`${w === "baseline" ? "基准" : "候选"}零件 SVG 工程视图`} src={`/api/cad/${cad.id}/files/${w}/drawing.svg`} />
        <figcaption>{w === "baseline" ? "基准" : "候选"} · OCCT 投影视图（含隐藏线）</figcaption></figure>)}</div>
      <Receipts value={{ request: cad.request, requirementDigest: cad.requirementDigest, receipts: cad.receipts, files: cad.files, parameters: { baseline: cad.baseline?.parameters, candidate: cad.candidate?.parameters } }} />
    </>}
  </>;
}

export function Validate() {
  const c = useApp();
  const { project, route, session } = c;
  const runs = projectRuns(c.data, project?.id);
  const kind = route.params.get("kind") as RunKind | null, id = route.params.get("id");
  const live = session?.running && session.kind !== "assistant" && session.kind !== "cad-sweep" ? { ...session, kind: session.kind as RunKind } : undefined;
  const selected: RunItem | undefined = runs.find(r => r.id === id) ?? (live && !id ? undefined : runs.find(r => !kind || r.kind === kind));
  const liveKind = live && !selected ? live.kind : undefined;
  // Keep the selected record visible in the list or strip (it may be off-screen after navigation).
  useEffect(() => { revealInScroller(document.querySelector(".run-list .run.selected")); }, [selected?.id]);
  if (!project) return <><ViewHeader step="阶段 3 / 6 · 原生验证" title="原生验证" /><Empty title="先冻结需求" action={<button type="button" onClick={() => c.navigate("requirements", { new: "1" })}>新建评审任务</button>} /></>;
  const detailKind = selected?.kind ?? liveKind;
  return <>
    <ViewHeader step="阶段 3 / 6 · 原生验证" title="原生验证" description="原生工具执行，独立检查对照；失败案例原样保留。实时事件只用于展示，结论以保存的记录为准。"
      actions={<button type="button" className="secondary" onClick={() => c.navigate("design")}>新候选</button>} />
    <div className="master-detail">
      <nav className="run-list" aria-label="检查记录">
        {runs.length === 0 && !live && <Empty title="还没有检查记录" action={<button type="button" onClick={() => c.navigate("design")}>提交候选</button>} />}
        {live && <button type="button" className={`run ${!selected ? "selected" : ""}`} aria-pressed={!selected} onClick={() => c.navigate("validate", { kind: live.kind })}>
          <span className="run-kind">{KIND_LABEL[live.kind]}</span><strong>{live.title}</strong><Chip tone="live">运行中</Chip></button>}
        {runs.map(r => { const v = verdictOf(r.kind, r.verdict, r.state); return <button key={r.id} type="button" className={`run ${selected?.id === r.id ? "selected" : ""}`}
          aria-pressed={selected?.id === r.id} aria-label={`${KIND_LABEL[r.kind]} ${r.title} ${v.label}`} onClick={() => c.navigate("validate", { kind: r.kind, id: r.id })}>
          <span className="run-kind">{KIND_LABEL[r.kind]}{r.recheck ? " · 复测" : ""}</span><strong>{r.title}</strong><Chip tone={v.tone}>{v.label}</Chip>
          <small>{time(r.createdAt)} · 需求 v{r.revision} · {r.id.slice(0, 8)}</small></button>; })}
      </nav>
      <div className="detail">
        {session && session.kind !== "assistant" && session.kind !== "cad-sweep" && session.running && <Card><LiveSteps session={session} /></Card>}
        {detailKind === "robot-review" && selected && <ReviewDetail run={c.data.reviews.find(r => r.id === selected.id)!} />}
        {detailKind === "blender-scene" && <SceneDetail scene={selected ? c.data.scenes.find(s => s.id === selected.id) : undefined} />}
        {detailKind === "cad-part" && <CadDetail cad={selected ? (c.data.cads ?? []).find(s => s.id === selected.id) : undefined} />}
        {detailKind === "factory-twin" && selected && <FactoryResult review={(c.data.factoryReviews ?? []).find(r => r.id === selected.id)!} />}
        {liveKind && liveKind !== "blender-scene" && liveKind !== "cad-part" && <Empty title="正在执行原生任务">完成后显示结论与检查项。</Empty>}
        {session && session.kind !== "assistant" && session.kind !== "cad-sweep" && !session.running && session.recordId === selected?.id &&
          <details className="card run-log"><summary>本次执行记录 · {session.steps.length} 步</summary><LiveSteps session={session} /></details>}
        {selected && selected.state === "completed" && <>
          <CaseList runId={selected.id} />
          <CompareCandidates kind={selected.kind} selected={selected.id} />
          <div className="button-row end"><button type="button" className="secondary" onClick={() => c.navigate("evidence", { kind: selected.kind, id: selected.id })}>查看证据与回放 →</button></div>
        </>}
      </div>
    </div>
  </>;
}
