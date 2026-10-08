/**
 * The sample business process for the first artifact: solve, verify independently, accept only a verified feasible
 * plan, then a person (the dispatcher) confirms. Used by the UI as the starting definition and by the tests.
 * Pure data: no Node APIs, so the browser bundle can import it.
 */
export const planningWorkflow = (ref: string, over: Record<string, unknown> = {}) => ({
  schema: "pai-workflow-1", name: "offsite-delivery-plan", version: 1, title: "场外配送计划：求解 → 独立核验 → 调度员确认",
  inputs: { problem: { schema: "pai-logistics-problem-1" } },
  nodes: [
    { id: "solve", type: "artifact", artifact: ref, operation: "solve", inputs: { problem: "$input.problem" }, params: { strategy: "deterministic", timeLimitSeconds: 10 } },
    { id: "verify", type: "artifact", artifact: ref, operation: "verify", inputs: { problem: "$input.problem", plan: "$solve.plan" } },
    { id: "gate", type: "condition", status: "$verify", pass: ["feasible-plan"] },
    { id: "dispatcher", type: "approval", prompt: "调度员确认计划后才可交付（不会自动派车）", after: ["gate"] },
  ],
  outputs: { plan: "$solve.plan", verification: "$verify.verification" },
  ...over,
});
