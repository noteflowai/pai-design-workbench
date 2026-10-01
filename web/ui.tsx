import { useEffect, type ReactNode } from "react";
import type { RunKind, State } from "./context";
import { CAD_VARIANTS, CANDIDATES, KIND_LABEL } from "./context";

export type Tone = "ok" | "bad" | "warn" | "info" | "muted" | "live";
export function Chip({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}
export function ViewHeader({ step, title, description, actions }: { step: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return <div className="view-header"><div><p className="eyebrow">{step}</p><h1 tabIndex={-1}>{title}</h1>{description && <p className="lede">{description}</p>}</div>
    {actions && <div className="view-actions">{actions}</div>}</div>;
}
export function Card({ title, aside, children, className = "", id, label }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string; label?: string }) {
  return <section className={`card ${className}`} id={id} aria-label={label}>
    {(title || aside) && <div className="card-head">{title && <h2>{title}</h2>}{aside}</div>}{children}</section>;
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>;
}
export function Verdict({ tone, eyebrow, title, detail }: { tone: Tone; eyebrow: string; title: string; detail?: ReactNode }) {
  return <div className={`verdict ${tone}`}><span className="verdict-mark" aria-hidden="true">{tone === "ok" ? "✓" : tone === "bad" ? "!" : tone === "live" ? "◉" : "…"}</span>
    <div><p>{eyebrow}</p><h3>{title}</h3>{detail && <div className="verdict-detail">{detail}</div>}</div></div>;
}
export function Check({ passed, title, detail }: { passed: boolean | null; title: string; detail: string }) {
  return <li className={`check-item ${passed === false ? "fail" : passed === null ? "skip" : "pass"}`}>
    <span aria-hidden="true">{passed === null ? "—" : passed ? "✓" : "×"}</span>
    <div><strong>{title}</strong><p>{detail}</p></div><span className="visually-hidden">{passed === null ? "未要求" : passed ? "通过" : "未通过"}</span></li>;
}
export function Toasts({ items, dismiss }: { items: { id: number; message: string; tone: "ok" | "bad" }[]; dismiss: (id: number) => void }) {
  useEffect(() => {
    const timers = items.filter(t => t.tone === "ok").map(t => setTimeout(() => dismiss(t.id), 6000));
    return () => timers.forEach(clearTimeout);
  }, [items, dismiss]);
  return <div className="toasts">{items.map(t => <div key={t.id} role={t.tone === "bad" ? "alert" : "status"} className={`toast ${t.tone}`}>
    <span>{t.message}</span><button type="button" className="ghost" aria-label="关闭通知" onClick={() => dismiss(t.id)}>×</button></div>)}</div>;
}
export const time = (iso?: string) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

export interface RunItem { kind: RunKind; id: string; createdAt: string; state: string; verdict?: string; title: string; revision: number; recheck: boolean }
export function projectRuns(data: State, projectId?: string): RunItem[] {
  if (!projectId) return [];
  return [
    ...data.reviews.filter(r => r.projectId === projectId).map(r => ({ kind: "robot-review" as const, id: r.id, createdAt: r.createdAt, state: r.state,
      verdict: r.decision?.verdict, title: CANDIDATES[r.candidate], revision: r.projectRevision, recheck: Boolean(r.feedbackId) })),
    ...data.scenes.filter(r => r.projectId === projectId).map(r => ({ kind: "blender-scene" as const, id: r.id, createdAt: r.createdAt, state: r.state,
      verdict: r.verdict, title: r.request.variant === "occluded" ? "带遮挡候选布局" : "无遮挡布局", revision: r.projectRevision, recheck: Boolean(r.feedbackId) })),
    ...(data.cads ?? []).filter(r => r.projectId === projectId).map(r => ({ kind: "cad-part" as const, id: r.id, createdAt: r.createdAt, state: r.state,
      verdict: r.verdict, title: `NEMA 17 支架 · ${CAD_VARIANTS[r.request.variant][0]}`, revision: r.projectRevision, recheck: Boolean(r.feedbackId) })),
    ...(data.factoryReviews ?? []).filter(r => r.projectId === projectId).map(r => ({ kind: "factory-twin" as const, id: r.id, createdAt: r.createdAt, state: r.state,
      verdict: r.verdict, title: `维护/能源方案 · 标准 ${r.criteriaDigest.slice(0, 6)}`, revision: r.projectRevision, recheck: Boolean(r.feedbackId) })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
const VERDICTS: Record<RunKind, Record<string, [string, Tone]>> = {
  "robot-review": { "accepted-in-recorded-panel": ["记录样本内通过", "ok"], rejected: ["拒绝采用", "bad"], "needs-more-evidence": ["需要更多证据", "warn"] },
  "blender-scene": { "accepted-static-scene": ["静态场景检查通过", "ok"], rejected: ["场景检查拒绝", "bad"] },
  "cad-part": { "accepted-cad-part": ["零件检查通过", "ok"], rejected: ["零件检查拒绝", "bad"] },
  "factory-twin": { "accepted-illustrative": ["演示仿真范围内通过", "ok"], rejected: ["维护方案拒绝", "bad"] },
};
export function verdictOf(kind: RunKind, verdict: string | undefined, state: string): { label: string; tone: Tone } {
  if (state === "running") return { label: "运行中", tone: "live" };
  if (state === "failed") return { label: "执行失败", tone: "bad" };
  if (state === "interrupted") return { label: "已中断 · 需对账", tone: "warn" };
  const v = verdict ? VERDICTS[kind][verdict] : undefined;
  return v ? { label: v[0], tone: v[1] } : { label: state, tone: "muted" };
}
export { KIND_LABEL };
