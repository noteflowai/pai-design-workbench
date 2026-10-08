import { planningWorkflow } from "../../src/artifacts/samples.js";
export const planning = (over: Record<string, unknown> = {}) => planningWorkflow("logistics-pdptw@1.0.0", over);
