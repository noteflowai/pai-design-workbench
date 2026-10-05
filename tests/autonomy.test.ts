import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";

// Rules of a grant, checked through the HTTP API without native tools: a plan that would run a solver is refused
// for every reason a grant forbids, and nothing starts.
test("autonomy grants: tool scope, relaxation, quota, revocation and project scope are enforced before anything runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-grant-"));
  const { app } = await createApp({ ...configuration(), state: dir, cadquery: undefined, physicsPython: undefined, controllerEntrypoint: undefined });
  const host = "127.0.0.1:4317";
  const call = (method: "GET" | "POST", url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: JSON.stringify(payload) } : {}), headers: { host, "content-type": "application/json" } });
  try {
    const p = (await call("POST", "/api/projects", { title: "Grant rules", intendedDecision: "Check that grants bound native runs",
      requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } })).json();
    const other = (await call("POST", "/api/projects", { title: "Other project", intendedDecision: "A second project for scope checks",
      requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } })).json();
    const propose = async (projectId: string, payload: Record<string, unknown>, tool = "cad-review") => {
      const plan = (await call("POST", "/api/assistant/external-plans", { requestId: crypto.randomUUID(), projectId, agent: "test", intent: "grant rule check",
        output: { kind: "plan", plans: [{ ref: "p1", tool, payload }] } })).json();
      assert.equal(plan.plans.length, 1, JSON.stringify(plan.interpretation)); return { planId: plan.id };
    };
    const grant = (await call("POST", `/api/projects/${p.id}/autonomy-grants`, { tools: ["cad-review"], maxRuns: 1, hours: 1 })).json();
    assert.equal(grant.maxRuns, 1); assert.deepEqual(grant.runs, []);
    assert.equal((await call("POST", `/api/projects/${p.id}/autonomy-grants`, { tools: ["release"], maxRuns: 1 })).statusCode, 400, "only native lanes are grantable");

    const optimize = await propose(p.id, { requirements: {} }, "cad-optimize");
    const r1 = await call("POST", `/api/assistant/plans/${optimize.planId}/autonomous-runs`, { grantId: grant.id, step: "p1" });
    assert.equal(r1.json().error, "GRANT_SCOPE", "a tool outside the grant is refused");

    const relaxed = await propose(p.id, { variant: "reference", requirements: { minWallMm: 1 } });
    const r2 = await call("POST", `/api/assistant/plans/${relaxed.planId}/autonomous-runs`, { grantId: grant.id, step: "p1" });
    assert.equal(r2.json().error, "GRANT_RELAXATION", "a relaxing step needs a human");

    const elsewhere = await propose(other.id, { variant: "reference" });
    const r3 = await call("POST", `/api/assistant/plans/${elsewhere.planId}/autonomous-runs`, { grantId: grant.id, step: "p1" });
    assert.equal(r3.json().error, "GRANT_SCOPE", "a plan of another project is refused");

    const cfgMissing = await propose(p.id, { variant: "reference" });
    const r0 = await call("POST", `/api/assistant/plans/${cfgMissing.planId}/autonomous-runs`, { grantId: grant.id, step: "p1" });
    assert.equal(r0.json().error, "CAD_NOT_CONFIGURED", "a run that cannot start reports why");
    assert.equal((await call("GET", "/api/state")).json().autonomyGrants[0].runs.length, 0, "and gives its reserved run back");
    assert.equal((await call("POST", `/api/autonomy-grants/${grant.id}/revoke`, {})).json().revokedAt !== undefined, true);
    const ok = await propose(p.id, { variant: "reference" });
    const r4 = await call("POST", `/api/assistant/plans/${ok.planId}/autonomous-runs`, { grantId: grant.id, step: "p1" });
    assert.equal(r4.json().error, "GRANT_INACTIVE", "a revoked grant runs nothing");
    const state = (await call("GET", "/api/state")).json();
    assert.equal(state.autonomyGrants[0].runs.length, 0, "no quota was spent by refused calls");
    assert.equal((state.cads ?? []).length, 0, "no native run started");
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("every frozen CAD requirement is compared, so a grant cannot drop DFM, CAM or loosen the envelope unnoticed", async () => {
  const { cadRequirementChanges } = await import("../src/assistant.js");
  const { DEFAULT_CAD_REQUIREMENTS } = await import("../src/cad.js");
  const frozen = { ...DEFAULT_CAD_REQUIREMENTS, dfm: { maxSetups: 2, maxUnitCostEur: 16, cam: { maxCycleMinutes: 120 } } };
  const relaxed = (now: typeof frozen) => cadRequirementChanges(frozen, now).filter(c => c.direction === "relaxed").map(c => c.field);
  assert.deepEqual(relaxed({ ...frozen }), []);
  assert.deepEqual(relaxed({ ...frozen, dfm: undefined } as never), ["dfm"]);
  assert.deepEqual(relaxed({ ...frozen, dfm: { maxSetups: 2, maxUnitCostEur: 16 } } as never), ["dfm.cam"]);
  assert.deepEqual(relaxed({ ...frozen, dfm: { ...frozen.dfm, cam: { maxCycleMinutes: 200 } } }), ["dfm.cam.maxCycleMinutes"]);
  assert.deepEqual(relaxed({ ...frozen, maxEnvelopeMm: [90, 40, 60] }), ["maxEnvelopeMm[0]"]);
  assert.deepEqual(cadRequirementChanges(DEFAULT_CAD_REQUIREMENTS, frozen).filter(c => c.direction === "tightened").map(c => c.field), ["dfm"]);
});
