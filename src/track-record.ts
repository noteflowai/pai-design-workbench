import type { AssistantPlan } from "./assistant.js";
import type { RecordKind } from "./ontology/kinds.js";
import type { Store } from "./store.js";

/**
 * The measured track record of every AI that proposed work in a project: what the native solvers decided about the
 * proposals that were executed, whether people edited them first, whether they ran under a grant, how often they tried
 * to relax a frozen requirement, and how far the model's own physical estimates were from the solver.
 *
 * Nothing here is judged by a model. It is derived only from confirmed plan steps and the verdicts of the records they
 * produced, so it can be shown to people and fed back to the planner ("this is how your proposals fared").
 */
export type Outcome = "accepted" | "rejected" | "inconclusive" | "running" | "failed" | "applied";
export interface AgentRecord {
  agent: string; source: "model" | "external"; proposals: number; executed: number;
  outcomes: Record<Outcome, number>; editedBeforeRun: number; underGrant: number; relaxationsProposed: number;
  /** Accepted / (accepted + rejected); null until the solvers have decided at least one executed proposal. */
  acceptanceRate: number | null;
  /** The model's own estimates (optimisation seeds, deflection) against the solver: mean |error| and signed bias (negative: under-estimates). */
  estimates: { n: number; meanAbsRelativeError: number; bias: number } | null;
}
export interface TrackRecord {
  agents: AgentRecord[];
  recent: { agent: string; tool: string; recordKind: RecordKind; recordId: string; outcome: Outcome; at: string; failed?: string[] }[];
  scope: "native solver verdicts on executed AI proposals; simulation, not physical validation";
}

type Native = { state?: string; verdict?: string; decision?: { verdict?: string }; result?: { lightestFeasible?: number | null; aiSeeds?: { expected?: number | null; measured?: number | null }[] };
  candidate?: { checks?: { id: string; passed: boolean }[] } };

/** The verdict of an executed record as the native lane recorded it (never re-judged here). */
export function outcomeOf(kind: string, r: Native | undefined): Outcome {
  if (!r) return "failed";
  if (r.state === "running") return "running";
  if (r.state === "failed" || r.state === "interrupted") return "failed";
  if (kind === "cad-optimize" || kind === "cad-sweep") return r.result ? (r.result.lightestFeasible ?? null) !== null ? "accepted" : "rejected" : "failed";
  const verdict = kind === "review" ? r.decision?.verdict : r.verdict;
  if (["project", "proposal", "factory-criteria"].includes(kind)) return "applied";
  if (!verdict) return "inconclusive";
  return verdict.startsWith("accepted") ? "accepted" : verdict === "rejected" ? "rejected" : "inconclusive";
}

export const agentOf = (p: AssistantPlan) => p.source === "external" ? `${p.external?.agent ?? "external"} (MCP)`
  // "default" means the engine's own configured model (Claude Code: its provider default), so name the provider instead.
  : p.ai?.engine ? `${p.ai.engine.model && p.ai.engine.model !== "default" ? p.ai.engine.model : PROVIDER[p.ai.engine.provider] ?? p.ai.engine.provider} · ${p.ai.engine.profile}` : "model";
const PROVIDER: Record<string, string> = { claude: "Claude", codex: "Codex", kiro: "Kiro" };

export function trackRecord(store: Pick<Store, "list" | "get">, projectId: string): TrackRecord {
  const plans = store.list<AssistantPlan>("assistant-plan").filter(p => p.projectId === projectId && (p.source === "model" || p.source === "external"));
  const agents = new Map<string, AgentRecord>(), errors = new Map<string, number[]>();
  const recent: TrackRecord["recent"] = [];
  for (const plan of plans) {
    const agent = agentOf(plan);
    const a = agents.get(agent) ?? { agent, source: plan.source as "model" | "external", proposals: 0, executed: 0,
      outcomes: { accepted: 0, rejected: 0, inconclusive: 0, running: 0, failed: 0, applied: 0 }, editedBeforeRun: 0, underGrant: 0,
      relaxationsProposed: 0, acceptanceRate: null, estimates: null };
    agents.set(agent, a);
    a.proposals += plan.plans.length;
    a.relaxationsProposed += plan.plans.filter(s => s.changes.some(c => c.direction === "relaxed")).length;
    for (const c of plan.confirmations) {
      const step = plan.plans.find(s => s.id === c.planId);
      const record = store.get<Native>(c.recordKind, c.recordId);
      const outcome = outcomeOf(c.recordKind, record);
      a.executed++; a.outcomes[outcome]++;
      if (c.match === "edited-before-execution") a.editedBeforeRun++;
      if ((c as { grantId?: string }).grantId) a.underGrant++;
      // Signed relative error of each estimate (expected - measured) / measured: negative means the model under-estimated.
      for (const s of record?.result?.aiSeeds ?? []) if (typeof s.expected === "number" && typeof s.measured === "number" && s.measured !== 0)
        (errors.get(agent) ?? errors.set(agent, []).get(agent)!).push((s.expected - s.measured) / s.measured);
      recent.push({ agent, tool: step?.tool ?? c.recordKind, recordKind: c.recordKind, recordId: c.recordId, outcome, at: c.at,
        ...(outcome === "rejected" && record?.candidate?.checks ? { failed: record.candidate.checks.filter(k => !k.passed).map(k => k.id) } : {}) });
    }
  }
  for (const a of agents.values()) {
    const decided = a.outcomes.accepted + a.outcomes.rejected;
    a.acceptanceRate = decided ? Math.round(a.outcomes.accepted / decided * 1000) / 1000 : null;
    const e = errors.get(a.agent);
    if (e?.length) a.estimates = { n: e.length, meanAbsRelativeError: round(e.reduce((s, x) => s + Math.abs(x), 0) / e.length),
      bias: round(e.reduce((s, x) => s + x, 0) / e.length) };
  }
  return { agents: [...agents.values()].sort((x, y) => y.executed - x.executed), recent: recent.sort((x, y) => y.at.localeCompare(x.at)).slice(0, 8),
    scope: "native solver verdicts on executed AI proposals; simulation, not physical validation" };
}
const round = (x: number) => Math.round(x * 1000) / 1000;
