import { createContext, useContext } from "react";
import type { Campaign, Feedback, Project, Review } from "../src/contracts";
import type { Proposal } from "../src/proposals";
import type { SceneReview } from "../src/scenes";
import type { FactoryCriteria, FactoryCriteriaValues, FactoryReview } from "../src/factory";
import type { AssistantPlan } from "../src/assistant";
import type { CadReview, CadRequirements } from "../src/cad";
import type { Lifecycle, StageId, EvidenceKind } from "../src/lifecycle";
import type { LiveSession, LiveTrack } from "./studio";

export type RunKind = EvidenceKind;
export type ViewId = "overview" | StageId;
export type State = {
  projects: Project[]; reviews: Review[]; feedback: Feedback[]; campaigns: Campaign[]; proposals: Proposal[]; scenes: SceneReview[]; cads?: CadReview[];
  factoryCriteria?: FactoryCriteria[]; factoryReviews?: FactoryReview[]; assistantPlans?: AssistantPlan[]; lifecycles?: Record<string, Lifecycle>;
  metrics: { independentParticipants: number; independentEvents: number; independentRepeatUsers: number; maintainerEvents: number; fixtureEvents: number };
  capabilities: { modelProposal: boolean; blender: boolean; cad?: false | { engine: string; defaultRequirements: CadRequirements }; authenticatedWorkspace?: boolean; factoryTwin?: { defaultCriteria: FactoryCriteriaValues; reviewedSample?: string } };
};
export const VIEWS: { id: ViewId; label: string; short: string; index?: number }[] = [
  { id: "overview", label: "项目总览", short: "总览" },
  { id: "requirements", label: "需求冻结", short: "需求", index: 1 },
  { id: "design", label: "候选设计", short: "设计", index: 2 },
  { id: "validate", label: "原生验证", short: "验证", index: 3 },
  { id: "evidence", label: "失败回放", short: "证据", index: 4 },
  { id: "feedback", label: "反馈复测", short: "反馈", index: 5 },
  { id: "deliver", label: "交付试用", short: "交付", index: 6 },
];
export interface Route { view: ViewId; params: URLSearchParams }
export interface Ctx {
  data: State; project?: Project; lifecycle?: Lifecycle; busy: boolean; route: Route;
  navigate(view: ViewId, params?: Record<string, string | undefined>): void;
  perform(action: () => Promise<unknown>, message: string): Promise<boolean>;
  refresh(): Promise<State>; selectProject(id: string): void; toast(message: string, tone?: "ok" | "bad"): void;
  track: LiveTrack; session?: LiveSession; openAssistant(): void;
}
export const AppContext = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
}
export const CAD_VARIANTS: Record<string, [string, string]> = {
  reference: ["基准设计", "4 mm 板厚 · Ø22.5 止口 · 完整安装板"], lightweight: ["轻量化", "板厚降至 2.5 mm 以减重"],
  "undersize-bore": ["止口孔偏小", "止口孔 Ø21.5 mm（电机止口 Ø22）"], compact: ["紧凑化", "降低安装板高度与宽度"],
};
export const CAD_CHECK_LABELS: Record<string, string> = { "solid-valid": "实体有效性", "nema17-interface": "NEMA 17 接口", "motor-interference": "电机装配干涉",
  "min-wall": "最小壁厚", "hole-edge-distance": "孔边距", mass: "质量", envelope: "外形包络" };
export const CANDIDATES = { reference: "基准设置", camera: "相机偏移", dim: "弱光设置" } as const;
export const FEEDBACK_STATUS: Record<string, string> = {
  received: "已收到", "needs-context": "待补充", reproducible: "已复现", assigned: "已分配",
  "fix-proposed": "方案已提出", "no-change-with-reason": "保留并说明", rechecked: "已复测", closed: "已关闭",
};
export const KIND_LABEL: Record<RunKind, string> = { "robot-review": "机器人记录", "blender-scene": "Blender 场景", "factory-twin": "工厂孪生", "cad-part": "CAD 零件" };
