import { createHash } from "node:crypto";
import type { CandidateId, Decision, DiffResult, Project, Review, StressResult } from "./contracts.js";

export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function validatePanel(stress: StressResult): void {
  if (new Set(stress.conditions.map(c => c.id)).size !== 3
      || stress.conditions.some(c => c.trials !== 10 || c.successes > c.trials)) {
    throw new DomainError("INVALID_PANEL", "Incomplete or duplicated condition panel", 422);
  }
  for (const condition of ["camera", "dim"] as const) {
    const pairs = stress.pairs.filter(p => p.condition === condition);
    if (pairs.length !== 10 || new Set(pairs.map(p => p.seed)).size !== 10) {
      throw new DomainError("INVALID_PAIRS", "Missing or duplicated paired seed", 422);
    }
    const reference = pairs.filter(p => p.reference_success).length;
    const current = pairs.filter(p => p.condition_success).length;
    const test = stress.paired_exact_test.comparisons.filter(p => p.condition === condition);
    if (test.length !== 1 || reference !== stress.conditions.find(c => c.id === "reference")!.successes
        || current !== stress.conditions.find(c => c.id === condition)!.successes
        || test[0].lost_success !== pairs.filter(p => p.reference_success && !p.condition_success).length
        || test[0].gained_success !== pairs.filter(p => !p.reference_success && p.condition_success).length) {
      throw new DomainError("INCONSISTENT_RESULTS", "Native totals and paired outcomes disagree", 422);
    }
  }
  const reference = new Map(stress.pairs.filter(p => p.condition === "camera").map(p => [p.seed, p.reference_success]));
  if (stress.pairs.some(p => p.reference_success !== reference.get(p.seed))) {
    throw new DomainError("INCONSISTENT_REFERENCE", "Reference outcome differs across paired conditions", 422);
  }
  const tests = stress.paired_exact_test.comparisons;
  const exact = tests.map(t => {
    const n = t.lost_success + t.gained_success, k = Math.min(t.lost_success, t.gained_success);
    let sum = 0, choose = 1;
    for (let i = 0; i <= k; i++) { if (i) choose = choose * (n - i + 1) / i; sum += choose; }
    return Math.min(1, 2 * sum / 2 ** n);
  });
  const order = [0, 1].sort((a, b) => exact[a] - exact[b]);
  const adjusted = Array<number>(2);
  adjusted[order[0]] = Math.min(1, exact[order[0]] * 2);
  adjusted[order[1]] = Math.max(adjusted[order[0]], exact[order[1]]);
  if (tests.some((t, i) => Math.abs(t.exact_p_two_sided - exact[i]) > 1e-10
      || Math.abs(t.holm_adjusted_p - adjusted[i]) > 1e-10)) {
    throw new DomainError("INVALID_STATISTICS", "Exact paired statistics disagree with the outcomes", 422);
  }
}
export function validateDiff(stress: StressResult, candidate: CandidateId, diff: DiffResult) {
  const baseline = outcomes(stress, "reference"), current = outcomes(stress, candidate);
  const lost = [...baseline].filter(([seed, ok]) => ok && !current.get(seed)).length;
  if (diff.blocking_changes !== lost || diff.gate_passed !== (lost === 0)) {
    throw new DomainError("DIFF_MISMATCH", "EvalArc and recorded paired outcomes disagree", 422);
  }
}
export function outcomes(stress: StressResult, candidate: CandidateId): Map<number, boolean> {
  return new Map(stress.pairs.filter(p => p.condition === (candidate === "reference" ? "camera" : candidate))
    .map(p => [p.seed, candidate === "reference" ? p.reference_success : p.condition_success]));
}
function xml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}
export function junit(stress: StressResult, candidate: CandidateId): string {
  validatePanel(stress);
  const rows = [...outcomes(stress, candidate)].sort(([a], [b]) => a - b);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="smolvla-recorded-panel" tests="10" failures="${rows.filter(([, ok]) => !ok).length}">\n`
    + rows.map(([seed, ok]) => `<testcase classname="smolvla.task0" name="seed-${seed}"><properties><property name="condition" value="${xml(candidate)}"/></properties>${ok ? "" : '<failure message="Recorded task did not succeed"/>'}</testcase>`).join("\n")
    + "\n</testsuite>\n";
}
export function decide(project: Project, candidate: CandidateId, stress: StressResult, diff: DiffResult): Decision {
  validatePanel(stress);
  const metrics = stress.conditions.find(c => c.id === candidate)!;
  const comparison = stress.paired_exact_test.comparisons.find(c => c.condition === candidate);
  const significant = comparison ? comparison.holm_adjusted_p <= project.requirements.alpha
    && comparison.gained_success > comparison.lost_success : false;
  const checks: Decision["checks"] = [
    { id: "minimum-recorded-success", passed: metrics.successes / metrics.trials >= project.requirements.minSuccessRate,
      detail: `${metrics.successes}/${metrics.trials}; required ${project.requirements.minSuccessRate}` },
    { id: "preserve-baseline-success", passed: project.requirements.preserveBaselineSuccess ? diff.gate_passed : null,
      detail: `${diff.blocking_changes} recorded checks lost passes; null means requirement not selected` },
    { id: "independent-improvement", passed: project.requirements.requireSignificantImprovement ? significant : null,
      detail: comparison ? `Holm p=${comparison.holm_adjusted_p}; alpha=${project.requirements.alpha}` : "Reference is not an improvement comparison" },
  ];
  const hardFailure = checks.slice(0, 2).some(c => c.passed === false);
  return { verdict: hardFailure ? "rejected" : checks[2].passed === false ? "needs-more-evidence" : "accepted-in-recorded-panel",
    checks, scope: "retrospective-recorded-simulation", physicalValidation: false };
}
export function caseText(run: Review): string {
  const condition = run.stress?.conditions.find(c => c.id === run.candidate);
  const test = run.stress?.paired_exact_test.comparisons.find(c => c.condition === run.candidate);
  return `# ${run.project.title}\n\nDecision: ${run.decision?.verdict ?? "pending"}\nCandidate: ${run.candidate}; recorded successes: ${condition?.successes ?? "unknown"}/${condition?.trials ?? "unknown"}.\n`
    + `EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}. Holm p: ${test?.holm_adjusted_p ?? "not applicable"}.\n`
    + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: retrospective recorded simulation, one task and ten paired seeds. No new policy inference, physical validation or demonstrated population improvement.\n";
}
