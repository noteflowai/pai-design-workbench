import { api, requestIdFor } from "./api";
import { CANDIDATES, type Ctx } from "./context";
import type { CandidateId, Feedback, Review } from "../src/contracts";
import type { SceneReview } from "../src/scenes";
import type { FactoryReview } from "../src/factory";
import type { FailingCase } from "../src/lifecycle";
import type { CadReview, CadRequirements } from "../src/cad";
import { CAD_VARIANTS } from "./context";

export function runCad(c: Ctx, variant: string, requirements: CadRequirements) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-cad-${p.id}-${p.revision}-${variant}-${JSON.stringify(requirements)}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "cad-part" });
    const r = await c.track(requestId, `CadQuery 参数化零件 · ${CAD_VARIANTS[variant][0]}`, "cad-part",
      () => api<CadReview>(`/projects/${p.id}/cad`, { requestId, projectRevision: p.revision, variant, requirements }));
    c.navigate("validate", { kind: "cad-part", id: r.id });
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
  }, "原生 CAD 零件与独立检查已生成。");
}

/** Every native action: navigate to validation first so live progress is visible, then run with a durable identity. */
export function runReview(c: Ctx, candidate: CandidateId, feedbackId?: string) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-request-${p.id}-${p.revision}-${candidate}-${feedbackId ?? "initial"}`);
  return c.perform(async () => {
    if (!feedbackId) c.navigate("validate", { kind: "robot-review" });
    const r = await c.track(requestId, `Robot Reel 记录评审 · ${CANDIDATES[candidate]}`, "robot-review", () =>
      api<Review>(`/projects/${p.id}/reviews`, { requestId, projectRevision: p.revision, candidate, ...(feedbackId ? { feedbackId } : {}) }));
    if (!feedbackId) c.navigate("validate", { kind: "robot-review", id: r.id });
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
    return r;
  }, "原生检查已完成。重复提交会返回同一回执。");
}
export type SceneRequirements = { maxFootprintArea: number; targetEnvelopeRadius: number; requireTargetVisible: boolean };
export function runScene(c: Ctx, variant: "clear" | "occluded", requirements: SceneRequirements) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-scene-${p.id}-${p.revision}-${variant}-${JSON.stringify(requirements)}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "blender-scene" });
    const s = await c.track(requestId, `Blender 原生场景 · ${variant === "occluded" ? "带遮挡候选" : "无遮挡布局"}`, "blender-scene",
      () => api<SceneReview>(`/projects/${p.id}/scenes`, { requestId, projectRevision: p.revision, variant, requirements }));
    c.navigate("validate", { kind: "blender-scene", id: s.id });
    if (s.state !== "completed") throw new Error(s.error ?? s.state);
  }, "原生 Blender 场景和独立检查已生成。");
}
export function runFactory(c: Ctx, criteriaId: string) {
  const p = c.project!;
  const requestId = requestIdFor(`pai-fr-${p.id}-${criteriaId}`);
  return c.perform(async () => {
    c.navigate("validate", { kind: "factory-twin" });
    const r = await c.track(requestId, "工厂孪生逐种子评估", "factory-twin", () => api<FactoryReview>(`/projects/${p.id}/factory-reviews`,
      { requestId, projectRevision: p.revision, criteriaId, source: { kind: "reviewed-sample", sampleId: "robot-reel-v0.18.0-b3ee5c7" } }));
    c.navigate("validate", { kind: "factory-twin", id: r.id });
  }, "已按冻结标准评估全部配对种子。");
}

const CHECK_TEXT: Record<string, [string, string]> = {
  "camera-visibility": ["相机射线首先命中目标", "原生射线被遮挡物阻挡，需要移除遮挡并复测"],
  "footprint-area": ["占地不超过冻结上限", "原生占地超过冻结上限"],
  "declared-target-envelope": ["目标位于声明的静态包络内", "目标超出声明的静态包络"],
  "min-wall": ["所有板与孔间韧带壁厚不低于冻结下限", "候选零件实测最小壁厚低于下限，需要恢复板厚并复测"],
  "nema17-interface": ["NEMA 17 止口与 4× M3 孔符合接口尺寸", "候选零件接口尺寸不符，需要恢复止口孔并复测"],
  "motor-interference": ["电机装配无干涉", "候选零件与电机止口发生干涉，需要恢复止口孔并复测"],
  "hole-edge-distance": ["紧固孔边距不低于 1.5×d", "候选零件孔边距不足，需要恢复安装板尺寸并复测"],
  mass: ["质量不超过上限", "候选零件超重"], envelope: ["外形不超过包络", "候选零件超出外形包络"],
};
export function recordCaseFeedback(c: Ctx, fc: FailingCase) {
  const review = c.data.reviews.find(r => r.id === fc.runId);
  const payload = fc.kind === "robot-review"
    ? { runId: fc.runId, kind: "regression", seed: fc.seed, expected: `保留基准设置在 seed ${fc.seed} 的成功结果`,
      observed: `${CANDIDATES[review?.candidate ?? "camera"]}后 seed ${fc.seed} 失败，需要回退并复测`, actorKind: "maintainer" }
    : fc.kind === "blender-scene" || fc.kind === "cad-part"
      ? { runId: fc.runId, evidenceKind: fc.kind, kind: "design-check", checkId: fc.checkId, seed: null,
        expected: CHECK_TEXT[fc.checkId!]?.[0] ?? "原生检查通过", observed: CHECK_TEXT[fc.checkId!]?.[1] ?? fc.label, actorKind: "maintainer" }
      : { runId: fc.runId, evidenceKind: "factory-twin", kind: "design-check", checkId: fc.checkId, seed: fc.seed,
        expected: `seed ${fc.seed} 满足冻结标准`, observed: `${fc.label}；保留失败并等待上游重跑或说明`, actorKind: "maintainer" };
  return c.perform(async () => {
    const f = await api<Feedback>("/feedback", payload);
    c.navigate("feedback", { id: f.id });
  }, "反馈已绑定原始证据与失败案例。");
}

export const nextStatus = (f: Feedback) => ({ received: "reproducible", "needs-context": "reproducible", reproducible: "assigned",
  assigned: f.evidenceKind === "factory-twin" ? "no-change-with-reason" : "fix-proposed", rechecked: "closed" } as Record<string, string>)[f.status];
export const feedbackAction = (f: Feedback) => ({ received: "记录复现", "needs-context": "补充并复现", reproducible: "分配处理",
  assigned: f.evidenceKind === "factory-twin" ? "记录保留原因" : "提出回退方案",
  "fix-proposed": f.evidenceKind === "blender-scene" ? "移除遮挡并复测" : f.evidenceKind === "cad-part" ? "恢复基准参数并复测" : "回退基准并复测", "no-change-with-reason": "复测保留方案",
  rechecked: "关闭已复测反馈" } as Record<string, string>)[f.status];
export const defaultReason = (f: Feedback) => ({
  received: "已按原始证据复现该失败案例。", "needs-context": "补充上下文后已复现。", reproducible: "分配给维护者处理。",
  assigned: f.evidenceKind === "factory-twin" ? "上游数据未变化：保留失败并记录为已知限制，等待上游以新参数重跑。"
    : f.evidenceKind === "blender-scene" ? "保持原几何约束，移除遮挡物并重新生成场景。"
    : f.evidenceKind === "cad-part" ? "恢复满足约束的基准参数（4 mm 板厚、Ø22.5 止口、完整安装板），零件要求不变，重新生成并检查。" : "回退到基准设置并重新执行原生检查。",
  "fix-proposed": "按记录的处理方案重新执行原生检查，并绑定新回执。", "no-change-with-reason": "按保留说明在原标准下重新评估，并绑定新回执。",
  rechecked: "新复测回执已核对；关闭反馈，原失败记录保留。" } as Record<string, string>)[f.status] ?? "";

export function advanceFeedback(c: Ctx, f: Feedback, reason: string) {
  const next = nextStatus(f), p = c.project!;
  if (next) return c.perform(() => api(`/feedback/${f.id}`, { expectedRevision: f.revision, status: next, reason }, "PATCH"), "反馈状态已保存。");
  return c.perform(async () => {
    const requestId = requestIdFor(`pai-recheck-${f.id}-${p.revision}-${f.revision}-${f.status}`);
    const keep = f.status === "no-change-with-reason";
    let r: { id: string; state: string; error?: string };
    if (f.evidenceKind === "blender-scene") {
      const original = c.data.scenes.find(s => s.id === f.runId)!;
      r = await c.track(requestId, "Blender 反馈复测", "blender-scene", () => api<SceneReview>(`/projects/${p.id}/scenes`,
        { requestId, projectRevision: p.revision, variant: keep ? original.request.variant : "clear", requirements: original.request.requirements, feedbackId: f.id }));
    } else if (f.evidenceKind === "cad-part") {
      const original = (c.data.cads ?? []).find(x => x.id === f.runId)!;
      r = await c.track(requestId, "CAD 反馈复测", "cad-part", () => api<CadReview>(`/projects/${p.id}/cad`,
        { requestId, projectRevision: p.revision, variant: keep ? original.request.variant : "reference", requirements: original.request.requirements, feedbackId: f.id }));
    } else if (f.evidenceKind === "factory-twin") {
      const original = (c.data.factoryReviews ?? []).find(x => x.id === f.runId)!;
      r = await c.track(requestId, "工厂孪生反馈复测", "factory-twin", () => api<FactoryReview>(`/projects/${p.id}/factory-reviews`,
        { requestId, projectRevision: p.revision, criteriaId: original.criteriaId, source: original.request.source, feedbackId: f.id }));
    } else {
      const original = c.data.reviews.find(x => x.id === f.runId)!;
      r = await c.track(requestId, "Robot Reel 反馈复测", "robot-review", () => api<Review>(`/projects/${p.id}/reviews`,
        { requestId, projectRevision: p.revision, candidate: keep ? original.candidate : "reference", feedbackId: f.id }));
    }
    if (r.state !== "completed") throw new Error(r.error ?? r.state);
    await api(`/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason, recheckRunId: r.id }, "PATCH");
  }, "已按记录的处理方案重新检查，并绑定新复测回执。");
}
