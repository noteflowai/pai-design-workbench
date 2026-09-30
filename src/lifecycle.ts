import type { Campaign, Feedback, Project, Review } from "./contracts.js";
import { canonical, outcomes, sha256 } from "./domain.js";
import type { FactoryCriteria, FactoryReview } from "./factory.js";
import type { SceneReview } from "./scenes.js";
import type { AssistantPlan } from "./assistant.js";
import type { Proposal } from "./proposals.js";

/**
 * Lifecycle state derived only from durable records: requirement → design → native validation →
 * evidence/failure cases → feedback and recheck → handoff/pilot, looping back through feedback.
 * Read-only; it never changes a verdict and has no side effects.
 */
export type StageId = "requirements" | "design" | "validate" | "evidence" | "feedback" | "deliver";
export type StageStatus = "pending" | "active" | "attention" | "done";
export type EvidenceKind = "robot-review" | "blender-scene" | "factory-twin";
export interface StageState { id: StageId; index: number; label: string; status: StageStatus; metric: string; detail: string }
export interface FailingCase { kind: EvidenceKind; runId: string; seed: number | null; checkId?: string; label: string; feedbackId?: string; feedbackStatus?: string }
export interface Activity { at: string; stage: StageId; label: string; detail?: string; ref?: { kind: EvidenceKind | "feedback" | "campaign" | "plan"; id: string } }
export interface NextStep { stage: StageId; label: string; detail: string; ref?: { kind: string; id: string } }
export interface Lifecycle {
  projectId: string; revision: number; requirementDigest: string;
  stages: StageState[]; next: NextStep; failingCases: FailingCase[]; activity: Activity[];
  counts: { runs: number; running: number; rejected: number; accepted: number; openFeedback: number; closedFeedback: number; drafts: number; observations: number };
}
export interface LifecycleSnapshot {
  project: Project; reviews: Review[]; scenes: SceneReview[]; factoryCriteria: FactoryCriteria[]; factoryReviews: FactoryReview[];
  feedback: Feedback[]; campaigns: Campaign[]; events: { campaignId: string; kind: string; actorKind: string; at: string; participantId: string }[];
  plans: AssistantPlan[]; proposals: Proposal[];
}

const STATUS: Record<string, string> = { received: "已收到", "needs-context": "待补充", reproducible: "已复现", assigned: "已分配",
  "fix-proposed": "方案已提出", "no-change-with-reason": "保留并说明", rechecked: "已复测", closed: "已关闭" };
const NEXT_FEEDBACK: Record<string, string> = { received: "记录复现", "needs-context": "补充并复现", reproducible: "分配处理",
  assigned: "提出处理方案", "fix-proposed": "按方案复测", "no-change-with-reason": "按保留说明复测", rechecked: "关闭已复测反馈" };
const VERDICT: Record<string, string> = { "accepted-in-recorded-panel": "记录样本内通过", rejected: "拒绝", "needs-more-evidence": "需要更多证据",
  "accepted-static-scene": "静态场景通过", "accepted-illustrative": "演示范围内通过" };
const FACTORY_CHECK: Record<string, string> = { "output-per-seed": "单种子产出", "demand-intervals": "需量超限", "hall-comfort": "车间舒适度",
  "ev-service": "EV 充电服务", "closed-failures": "闭环故障" };
const SCENE_CHECK: Record<string, string> = { "footprint-area": "静态占地", "declared-target-envelope": "声明的目标包络", "camera-visibility": "相机可见性" };
const CANDIDATE: Record<string, string> = { reference: "基准设置", camera: "相机偏移", dim: "弱光设置" };

function latestBy<T extends { createdAt: string }>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) map.set(key(item), item);
  return [...map.values()];
}

export function failingCases(s: LifecycleSnapshot): FailingCase[] {
  const cases: FailingCase[] = [];
  const bind = (c: Omit<FailingCase, "feedbackId" | "feedbackStatus">): FailingCase => {
    const f = [...s.feedback].reverse().find(x => x.runId === c.runId && x.seed === c.seed && (c.checkId === undefined || x.checkId === c.checkId));
    return { ...c, feedbackId: f?.id, feedbackStatus: f?.status };
  };
  // Initial (non-recheck) runs; the latest per candidate so repeated identical runs do not inflate the count.
  for (const r of latestBy(s.reviews.filter(r => r.state === "completed" && !r.feedbackId && r.stress && r.candidate !== "reference"), r => r.candidate)) {
    const base = outcomes(r.stress!, "reference"), current = outcomes(r.stress!, r.candidate);
    for (const [seed, ok] of [...base].sort(([a], [b]) => a - b)) if (ok && current.get(seed) === false) {
      cases.push(bind({ kind: "robot-review", runId: r.id, seed, label: `seed ${seed}：基准成功，${CANDIDATE[r.candidate]}失败` }));
    }
  }
  for (const sc of latestBy(s.scenes.filter(x => x.state === "completed" && !x.feedbackId), x => canonical(x.request.requirements) + x.request.variant)) {
    for (const check of sc.baseline?.checks ?? []) {
      if (check.passed && sc.candidate?.checks.find(c => c.id === check.id)?.passed === false) {
        cases.push(bind({ kind: "blender-scene", runId: sc.id, seed: null, checkId: check.id, label: `Blender ${SCENE_CHECK[check.id] ?? check.id}：基准通过，候选失败` }));
      }
    }
  }
  for (const f of latestBy(s.factoryReviews.filter(x => !x.feedbackId), x => x.criteriaId)) {
    for (const [checkId, seeds] of Object.entries(f.aggregate.failingSeeds)) for (const seed of seeds) {
      cases.push(bind({ kind: "factory-twin", runId: f.id, seed, checkId, label: `工厂 seed ${seed}：${FACTORY_CHECK[checkId] ?? checkId}未满足冻结标准` }));
    }
  }
  return cases;
}

export function computeLifecycle(s: LifecycleSnapshot): Lifecycle {
  const { project } = s;
  const runs = [
    ...s.reviews.map(r => ({ kind: "robot-review" as const, id: r.id, state: r.state, verdict: r.decision?.verdict, createdAt: r.createdAt, key: `robot:${r.candidate}` })),
    ...s.scenes.map(r => ({ kind: "blender-scene" as const, id: r.id, state: r.state, verdict: r.verdict, createdAt: r.createdAt, key: `scene:${r.request.variant}:${canonical(r.request.requirements)}` })),
    ...s.factoryReviews.map(r => ({ kind: "factory-twin" as const, id: r.id, state: r.state, verdict: r.verdict, createdAt: r.createdAt, key: `factory:${r.criteriaId}` })),
  ];
  const completed = runs.filter(r => r.state === "completed"), running = runs.filter(r => r.state === "running");
  const broken = runs.filter(r => r.state === "failed" || r.state === "interrupted");
  const rejected = completed.filter(r => r.verdict === "rejected" || r.verdict === "needs-more-evidence").length;
  const cases = failingCases(s), uncovered = cases.filter(c => !c.feedbackId);
  const open = s.feedback.filter(f => f.status !== "closed"), closed = s.feedback.filter(f => f.status === "closed");
  const observations = s.events.length;
  const candidates = new Set(runs.map(r => r.key)).size;
  const stages: StageState[] = [
    { id: "requirements", index: 1, label: "需求冻结", status: "done", metric: `需求 v${project.revision}`,
      detail: `${s.factoryCriteria.length} 个工厂标准版本；后续检查绑定需求哈希` },
    { id: "design", index: 2, label: "候选设计", status: candidates || s.plans.length ? "done" : "pending",
      metric: `${candidates} 个候选`, detail: `${s.plans.length} 个 AI 计划 · ${s.proposals.length} 个模型提案` },
    { id: "validate", index: 3, label: "原生验证", status: running.length ? "active" : !completed.length ? (broken.length ? "attention" : "pending") : broken.length > 0 && broken.at(-1)!.createdAt > completed.at(-1)!.createdAt ? "attention" : "done",
      metric: `${completed.length} 次完成`, detail: `${rejected} 次拒绝 · ${completed.length - rejected} 次通过${running.length ? ` · ${running.length} 个运行中` : ""}${broken.length ? ` · ${broken.length} 个中断/失败` : ""}` },
    { id: "evidence", index: 4, label: "失败回放", status: !completed.length ? "pending" : uncovered.length ? "attention" : "done",
      metric: `${cases.length} 个失败案例`, detail: uncovered.length ? `${uncovered.length} 个尚未记录反馈` : "失败案例均已绑定反馈" },
    { id: "feedback", index: 5, label: "反馈复测", status: open.length ? "attention" : closed.length ? "done" : "pending",
      metric: `${open.length} 待处理 · ${closed.length} 已关闭`, detail: "复现 → 分配 → 处理 → 新复测 → 关闭" },
    { id: "deliver", index: 6, label: "交付试用", status: s.campaigns.length ? "done" : "pending",
      metric: `${s.campaigns.length} 份草稿 · ${observations} 条观察`, detail: "证据包、案例草稿与实际试用记录；不自动发送" },
  ];
  const oldestOpen = [...open].sort((a, b) => a.history[0].at.localeCompare(b.history[0].at))[0];
  const next: NextStep = running.length ? { stage: "validate", label: "查看运行中的原生任务", detail: "实时查看步骤与几何；完成后结论以保存的记录为准。", ref: { kind: running[0].kind, id: running[0].id } }
    : !completed.length ? { stage: "design", label: "提交第一个候选进行原生验证", detail: "选择机器人记录、Blender 场景或工厂孪生候选，也可以在 AI 助手中描述意图。" }
    : oldestOpen ? { stage: "feedback", label: `推进反馈：${NEXT_FEEDBACK[oldestOpen.status]}`, detail: `当前状态“${STATUS[oldestOpen.status]}”；${oldestOpen.observed}`, ref: { kind: "feedback", id: oldestOpen.id } }
    : uncovered.length ? { stage: "evidence", label: "为失败案例记录反馈", detail: `${uncovered[0].label}。失败案例需要绑定反馈并复测。`, ref: { kind: uncovered[0].kind, id: uncovered[0].runId } }
    : !s.campaigns.length ? { stage: "deliver", label: "生成可核验交付与案例草稿", detail: "证据包可在另一台机器重新核验；草稿保留失败与范围限制。" }
    : { stage: "deliver", label: "记录实际试用观察", detail: "独立试用与维护者测试分开计量；没有曝光分母时不计算转化率。" };

  const activity: Activity[] = [{ at: project.createdAt, stage: "requirements", label: `创建任务并冻结需求`, detail: project.title }];
  for (const c of s.factoryCriteria) activity.push({ at: c.createdAt, stage: "requirements", label: "冻结工厂验收标准", detail: `摘要 ${c.digest.slice(0, 8)} · ${c.rationale}` });
  for (const p of s.plans) activity.push({ at: p.createdAt, stage: "design", label: "AI 助手生成计划", detail: p.message, ref: { kind: "plan", id: p.id } });
  for (const r of s.reviews) activity.push({ at: r.createdAt, stage: "validate", label: `Robot Reel 验证 · ${CANDIDATE[r.candidate]}${r.feedbackId ? "（反馈复测）" : ""}`, detail: r.decision ? VERDICT[r.decision.verdict] : r.state, ref: { kind: "robot-review", id: r.id } });
  for (const r of s.scenes) activity.push({ at: r.createdAt, stage: "validate", label: `Blender 场景 · ${r.request.variant === "occluded" ? "带遮挡" : "无遮挡"}${r.feedbackId ? "（反馈复测）" : ""}`, detail: r.verdict ? VERDICT[r.verdict] : r.state, ref: { kind: "blender-scene", id: r.id } });
  for (const r of s.factoryReviews) activity.push({ at: r.createdAt, stage: "validate", label: `工厂孪生评估${r.feedbackId ? "（反馈复测）" : ""}`, detail: `${VERDICT[r.verdict]} · 标准 ${r.criteriaDigest.slice(0, 8)}`, ref: { kind: "factory-twin", id: r.id } });
  for (const f of s.feedback) for (const h of f.history) activity.push({ at: h.at, stage: "feedback", label: `反馈${STATUS[h.status]}`, detail: h.reason, ref: { kind: "feedback", id: f.id } });
  for (const c of s.campaigns) activity.push({ at: c.createdAt, stage: "deliver", label: "生成案例草稿", detail: `${c.channel} · 未发送`, ref: { kind: "campaign", id: c.id } });
  for (const e of s.events) activity.push({ at: e.at, stage: "deliver", label: `试用观察 · ${e.kind}`, detail: `${e.actorKind} · ${e.participantId}` });
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    projectId: project.id, revision: project.revision, requirementDigest: sha256(canonical(project.requirements)),
    stages, next, failingCases: cases, activity: activity.slice(0, 40),
    counts: { runs: runs.length, running: running.length, rejected, accepted: completed.length - rejected, openFeedback: open.length,
      closedFeedback: closed.length, drafts: s.campaigns.length, observations },
  };
}
