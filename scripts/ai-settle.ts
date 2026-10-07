/**
 * Settle executor attempts whose effects are unknown, for the AI runs of one workbench state directory, through the
 * same path as the UI (reconcileAi -> executor `reconcile`). Runs with a recorded human reconciliation are settled with
 * that record. Runs without one are settled only when --reason is given (the operator's own check, recorded with
 * --actor). The executor checks every receipt and refuses unsafe ones; nothing is retried and the ledger is written
 * only by the executor.
 *   node --env-file=.state/demo.env --import tsx scripts/ai-settle.ts --state .state/live-x [--actor A --reason "..."]
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { configuration } from "../src/config.js";
import { Store } from "../src/store.js";
import { reconcileAi } from "../src/ai.js";
import type { AssistantPlan } from "../src/assistant.js";

const { values } = parseArgs({ options: { state: { type: "string" }, actor: { type: "string", default: "maintainer" }, reason: { type: "string" } } });
if (!values.state) throw new Error("--state is required");
const config = { ...configuration(), state: resolve(values.state) };
const store = new Store(resolve(values.state, "workbench.sqlite"));
const out = [];
try {
  for (const plan of store.list<AssistantPlan>("assistant-plan")) {
    if (plan.source !== "model" || !(plan.state === "reconcile" || plan.state === "interrupted")) continue;
    if (plan.ai?.reconciliation?.settlements) { out.push({ plan: plan.id, result: "already settled" }); continue; }
    if (!plan.ai?.reconciliation && !values.reason) { out.push({ plan: plan.id, result: "skipped: no human reconciliation and no --reason" }); continue; }
    const next = await reconcileAi(store, config, plan.id, { reason: values.reason ?? "" }, values.actor!);
    out.push({ plan: plan.id, by: next.ai?.reconciliation?.actor, settlements: next.ai?.reconciliation?.settlements ?? [] });
  }
} finally { store.close(); }
console.log(JSON.stringify(out));
