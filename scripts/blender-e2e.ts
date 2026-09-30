import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { command } from "../src/adapters.js";
import { createApp } from "../src/server.js";
import type { SceneReview } from "../src/scenes.js";
import type { Feedback, Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.blender, "Run npm run setup:native or set PAI_BLENDER");
const state = join(config.state, "blender-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const request = async <T>(method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload),
    headers: { host: `127.0.0.1:${config.port}`, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
try {
  const project = await request<Project>("POST", "/api/projects", { title: "Native Blender workcell design", intendedDecision: "Check static camera visibility with editable industrial scene evidence",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const requirements = { maxFootprintArea: 12, targetEnvelopeRadius: 1.4, requireTargetVisible: true };
  const originalRequest = { requestId: randomUUID(), projectRevision: 1, variant: "occluded", requirements };
  const scene = await request<SceneReview>("POST", `/api/projects/${project.id}/scenes`, originalRequest);
  assert.equal(scene.state, "completed", scene.error ?? "Native scene failed"); assert.equal(scene.verdict, "rejected");
  assert.equal(scene.diff?.blocking_changes, 1);
  assert.equal(scene.candidate?.checks.find(c => c.id === "camera-visibility")?.passed, false);
  assert.equal((await request<SceneReview>("POST", `/api/projects/${project.id}/scenes`, originalRequest)).id, scene.id);
  let f = await request<Feedback>("POST", "/api/feedback", { runId: scene.id, evidenceKind: "blender-scene",
    kind: "design-check", checkId: "camera-visibility", seed: null, expected: "Native camera ray reaches target", observed: "Occluder blocks target", actorKind: "maintainer" });
  for (const status of ["reproducible", "assigned", "fix-proposed"]) {
    f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status, reason: "Remove synthetic obstruction while retaining the same declared geometric constraints" });
  }
  const unfixed = await request<SceneReview>("POST", `/api/projects/${project.id}/scenes`,
    { ...originalRequest, requestId: randomUUID(), feedbackId: f.id });
  const denied = await app.inject({ method: "PATCH", url: `/api/feedback/${f.id}`, headers: { host: `127.0.0.1:${config.port}` },
    payload: { expectedRevision: f.revision, status: "rechecked", reason: "This unresolved native failure must remain open", recheckRunId: unfixed.id } });
  assert.equal(denied.statusCode, 409); assert.equal(denied.json().error, "ISSUE_NOT_FIXED");
  const fixed = await request<SceneReview>("POST", `/api/projects/${project.id}/scenes`,
    { ...originalRequest, requestId: randomUUID(), variant: "clear", feedbackId: f.id });
  assert.equal(fixed.state, "completed", fixed.error ?? "Native scene failed"); assert.equal(fixed.verdict, "accepted-static-scene");
  f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked",
    reason: "New native Blender production and independent comparison pass the reported check", recheckRunId: fixed.id });
  f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "Static occlusion corrected. No dynamic or physical safety claim." });
  const png = await app.inject({ url: `/api/scenes/${scene.id}/files/candidate/preview.png`, headers: { host: `127.0.0.1:${config.port}` } });
  assert.equal(png.statusCode, 200); assert.equal(png.rawPayload.subarray(1, 4).toString(), "PNG");
  const blend = await app.inject({ url: `/api/scenes/${scene.id}/files/candidate/scene.blend`, headers: { host: `127.0.0.1:${config.port}` } });
  assert.equal(blend.statusCode, 200); assert.ok(blend.rawPayload.length > 10_000);
  const glb = await app.inject({ url: `/api/scenes/${scene.id}/files/candidate/scene.glb`, headers: { host: `127.0.0.1:${config.port}` } });
  assert.equal(glb.statusCode, 200); assert.equal(glb.rawPayload.subarray(0, 4).toString(), "glTF");
  const reopen = join(state, "reopened.json");
  const opened = await command(config.blender!, ["--background", "--factory-startup", "--disable-autoexec",
    join(state, "scenes", scene.id, "candidate/scene.blend"), "--python-exit-code", "2",
    "--python", join(config.repository, "native/blender_reopen.py"), "--", reopen], config.repository, undefined, 60_000);
  assert.equal(opened.exitCode, 0);
  const roundtrip = JSON.parse(await readFile(reopen, "utf8"));
  assert.equal(roundtrip.rayFirstHit, "Visibility obstruction"); assert.equal(roundtrip.footprintArea, 12);
  assert.equal(roundtrip.unitSystem, "METRIC");
  const campaign = await request<{ state: string }>("POST", "/api/campaigns", { runId: scene.id, evidenceKind: "blender-scene", channel: "direct-pilot" });
  assert.equal(campaign.state, "draft");
  const report = { schema: "pai-blender-e2e-1", checkedAt: new Date().toISOString(), result: "passed",
    blenderVersion: scene.candidate!.blenderVersion, rejectedOcclusion: scene.verdict, blockingChanges: scene.diff!.blocking_changes,
    correctedScene: fixed.verdict, feedbackStatus: f.status, preventedUnfixedClosure: true,
    nativeArtifactKinds: ["editable-blend", "glb", "png", "native-checks-json"], roundtrip,
    physicalValidation: false, dynamicsValidated: false, manufacturabilityValidated: false, campaignPublished: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/blender-e2e.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
