const REF = "logistics-pdptw@1.0.0";
/** A planning workflow: solve, verify independently, accept only a verified feasible plan, then a person approves. */
export const planning = (over: Record<string, unknown> = {}) => ({
  schema: "pai-workflow-1", name: "offsite-delivery-plan", version: 1, title: "场外配送计划",
  inputs: { problem: { schema: "pai-logistics-problem-1" } },
  nodes: [
    { id: "solve", type: "artifact", artifact: REF, operation: "solve", inputs: { problem: "$input.problem" }, params: { timeLimitSeconds: 10 } },
    { id: "verify", type: "artifact", artifact: REF, operation: "verify", inputs: { problem: "$input.problem", plan: "$solve.plan" } },
    { id: "gate", type: "condition", status: "$verify", pass: ["feasible-plan"] },
    { id: "dispatcher", type: "approval", prompt: "调度员确认计划", after: ["gate"] },
  ],
  outputs: { plan: "$solve.plan", verification: "$verify.verification" }, ...over,
});
