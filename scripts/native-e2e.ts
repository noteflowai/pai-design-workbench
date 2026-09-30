import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { NativeAdapters } from "../src/adapters.js";
import { Store } from "../src/store.js";
import { Workbench } from "../src/service.js";
import { makeBundle } from "../src/bundle.js";
import { verifyWithNative } from "./verify-bundle.js";

const config = configuration();
const state = join(config.state, "native-e2e", randomUUID());
const store = new Store(join(state, "workbench.sqlite"));
const wb = new Workbench(store, new NativeAdapters(config), state);
try {
  const p = wb.createProject({ title: "Native camera review", intendedDecision: "Evaluate camera change while preserving baseline seed successes",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const request = { requestId: randomUUID(), projectRevision: 1, candidate: "camera" };
  const camera = await wb.runReview(p.id, request);
  assert.equal(camera.state, "completed", camera.error ?? "Native recording failed");
  assert.equal(camera.decision?.verdict, "rejected"); assert.equal(camera.diff?.blocking_changes, 1);
  assert.equal((await wb.runReview(p.id, request)).id, camera.id);
  let f = wb.createFeedback({ runId: camera.id, kind: "regression", seed: 9, expected: "Keep baseline success", observed: "Camera seed 9 fails", actorKind: "maintainer" });
  for (const status of ["reproducible", "assigned", "fix-proposed"]) {
    f = wb.transitionFeedback(f.id, { expectedRevision: f.revision, status, reason: "Verified recorded regression; rollback reference rather than claim a model repair" });
  }
  const rollback = await wb.runReview(p.id, { requestId: randomUUID(), projectRevision: 1, candidate: "reference", feedbackId: f.id });
  assert.equal(rollback.state, "completed", rollback.error ?? "Native recording failed");
  assert.equal(rollback.decision?.verdict, "accepted-in-recorded-panel");
  f = wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "rechecked", reason: "Native reference recheck preserves seed 9 in this recorded panel", recheckRunId: rollback.id });
  f = wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "closed", reason: "Rollback verified. No new optimized camera or physical deployment claimed." });
  const campaign = wb.createCampaign({ runId: camera.id, channel: "direct-pilot" });
  wb.trackEvent({ eventId: randomUUID(), campaignId: campaign.id, participantId: "native-e2e-maintainer", actorKind: "maintainer", kind: "completed" });
  assert.equal(wb.metrics().independentParticipants, 0);
  const bundle = makeBundle(camera);
  const handoff = await verifyWithNative(bundle, config.evalarcRoot);
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/camera-bundle.json"), JSON.stringify(bundle, null, 2), { mode: 0o600 });
  const report = { schema: "pai-native-e2e-1", checkedAt: new Date().toISOString(),
    result: "passed", source: "existing recorded simulation; no new inference",
    plannedTrials: camera.stress!.planned_trials,
    cameraDecision: camera.decision!.verdict,
    cameraSuccesses: camera.stress!.conditions.find(c => c.id === "camera")!.successes,
    baselineSuccesses: camera.stress!.conditions.find(c => c.id === "reference")!.successes,
    cameraLostPasses: camera.diff!.blocking_changes,
    cameraHolmP: camera.stress!.paired_exact_test.comparisons.find(c => c.condition === "camera")!.holm_adjusted_p,
    rollbackDecision: rollback.decision!.verdict, feedbackStatus: f.status, feedbackHistory: f.history.map(h => h.status),
    nativeReceiptExitCodes: [...camera.receipts, ...rollback.receipts].map(r => ({ adapter: r.adapter, exitCode: r.exitCode })),
    controller: camera.controller, handoff: { ...handoff, reviewId: "omitted-from-summary" }, metrics: wb.metrics(),
    freshSimulation: false, modelProposalExecuted: false, physicalValidated: false, campaignPublished: false };
  await writeFile(join(config.state, "evidence/native-e2e.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }
