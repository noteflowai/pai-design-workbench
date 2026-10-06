import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../src/store.js";
import { buildContext } from "../src/ai.js";
import { outcomeOf, trackRecord } from "../src/track-record.js";

const step = (id: string, tool: string, relaxed = false) => ({ id, tool, title: "t", route: "/", method: "POST", payload: {}, warnings: [], requiresConfirmation: true, evidence: "",
  changes: relaxed ? [{ field: "maxMassG", from: 175, to: 200, direction: "relaxed" }] : [] });
const plan = (id: string, extra: object) => ({ id, requestId: id, projectId: "p", message: "m", createdAt: "2026-10-06T00:00:00Z", interpretation: [], unmatched: false,
  authority: "none", model: { used: true, reason: "" }, ...extra });

test("the track record counts only what native records decided about executed AI proposals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-track-"));
  const store = new Store(join(dir, "s.sqlite"));
  const put = (kind: string, value: object) => store.insert(kind, value as { id: string });
  try {
    put("cad-review", { id: "c1", projectId: "p", state: "completed", verdict: "accepted-cad-part", request: { variant: "pillow-block", requirements: {} } });
    put("cad-review", { id: "c2", projectId: "p", state: "completed", verdict: "rejected", request: { variant: "parametric", requirements: {} },
      candidate: { checks: [{ id: "hole-edge-distance", passed: false }, { id: "mass", passed: true }] } });
    put("cad-optimize", { id: "o1", projectId: "p", state: "completed", request: {}, result: { points: [], feasibleCount: 0, lightestFeasible: 4,
      aiSeeds: [{ index: 1, expected: 0.05, measured: 0.058 }, { index: 2, expected: 0.054, measured: 0.06 }, { index: 3, expected: null, measured: 0.07 }] } });
    put("assistant-plan", plan("a1", { source: "model", ai: { attempts: [], engine: { profile: "kiro-backup", provider: "kiro", model: "claude-opus-5.5", engineVersion: null, modelEvidence: null } },
      plans: [step("p1", "cad-code"), step("p2", "cad-review", true)],
      confirmations: [{ planId: "p1", recordKind: "cad-review", recordId: "c2", at: "2026-10-06T01:00:00Z", match: "as-proposed", grantId: "g1" },
        { planId: "p2", recordKind: "cad-review", recordId: "c1", at: "2026-10-06T02:00:00Z", match: "edited-before-execution" }] }));
    put("assistant-plan", plan("a2", { source: "model", ai: { attempts: [], engine: { profile: "kiro-backup", provider: "kiro", model: "claude-opus-5.5", engineVersion: null, modelEvidence: null } },
      plans: [step("p1", "cad-optimize")], confirmations: [{ planId: "p1", recordKind: "cad-optimize", recordId: "o1", at: "2026-10-06T03:00:00Z", match: "as-proposed" }] }));
    put("assistant-plan", plan("a3", { source: "external", external: { agent: "agentforge", via: "mcp" }, plans: [step("p1", "cad-review")], confirmations: [] }));
    put("assistant-plan", plan("r1", { source: "rules", plans: [step("p1", "cad-review")], confirmations: [{ planId: "p1", recordKind: "cad-review", recordId: "c1", at: "x", match: "as-proposed" }] }));

    const t = trackRecord(store, "p");
    const kiro = t.agents.find(a => a.agent === "claude-opus-5.5 · kiro-backup")!;
    assert.deepEqual([kiro.proposals, kiro.executed, kiro.outcomes.accepted, kiro.outcomes.rejected], [3, 3, 2, 1]);
    assert.deepEqual([kiro.editedBeforeRun, kiro.underGrant, kiro.relaxationsProposed, kiro.acceptanceRate], [1, 1, 1, 0.667]);
    assert.equal(kiro.estimates!.n, 2, "seeds without an estimate are not scored");
    assert.ok(kiro.estimates!.bias < 0 && Math.abs(kiro.estimates!.bias + 0.119) < 0.002, "under-estimates show as a negative bias");
    const ext = t.agents.find(a => a.source === "external")!;
    assert.deepEqual([ext.agent, ext.proposals, ext.executed, ext.acceptanceRate], ["agentforge (MCP)", 1, 0, null]);
    assert.equal(t.agents.length, 2, "rule-based plans are not an AI");
    assert.deepEqual(t.recent.find(r => r.recordId === "c2")!.failed, ["hole-edge-distance"]);

    // The planner sees the same record, so it can avoid a check it already failed and correct its estimate bias.
    const ctx = buildContext(store, { id: "p", title: "t", revision: 1, requirements: {} } as never);
    const seen = (ctx.workspace as { aiTrackRecord: { agents: { accepted: number }[]; recentRejections: { failed: string[] }[] } }).aiTrackRecord;
    assert.equal(seen.agents[0].accepted, 2); assert.deepEqual(seen.recentRejections[0].failed, ["hole-edge-distance"]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("outcomes come from the lane's own verdict", () => {
  assert.equal(outcomeOf("review", { state: "completed", decision: { verdict: "needs-more-evidence" } }), "inconclusive");
  assert.equal(outcomeOf("scene-review", { state: "completed", verdict: "accepted-static-scene" }), "accepted");
  assert.equal(outcomeOf("cad-sweep", { state: "completed", result: { lightestFeasible: null } }), "rejected");
  assert.equal(outcomeOf("aero-review", { state: "interrupted" }), "failed");
  assert.equal(outcomeOf("project", { state: "completed" }), "applied");
});
