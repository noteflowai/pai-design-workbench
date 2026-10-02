/**
 * Native end-to-end check of the Blender factory production-line lane: a compact candidate whose larger guards
 * shrink the AGV aisle is rejected by the native ray measurement; the failure becomes feedback; a corrected layout
 * that keeps every requirement is rechecked natively and the feedback closes. Real Blender, real EvalArc.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { SceneReview } from "../src/scenes.js";
import type { Feedback, Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.blender, "Run npm run setup:native or set PAI_BLENDER");
const state = join(config.state, "plant-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const request = async <T>(method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
const measured = (s: SceneReview, id: string) => s.candidate!.checks.find(c => c.id === id) as unknown as { passed: boolean; observed: number; required: number };
try {
  const project = await request<Project>("POST", "/api/projects", { title: "CNC machining line layout", intendedDecision: "Fit a six-station line in 650 m² with native layout checks",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const requirements = { maxFootprintArea: 650, minAisleWidth: 2.4, minGuardClearance: 0.5, requireCameraCoverage: true, maxEgressTravel: 25 };
  const compact = { stations: 6, stationPitch: 4.5, aisleWidth: 2.4, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 };
  const first = { requestId: randomUUID(), projectRevision: 1, variant: "plant", layout: compact, requirements };
  const scene = await request<SceneReview>("POST", `/api/projects/${project.id}/scenes`, first);
  assert.equal(scene.state, "completed", scene.error ?? "native plant failed"); assert.equal(scene.verdict, "rejected");
  assert.equal(scene.baseline!.checks.every(c => c.passed), true, "Reference line passes the frozen layout requirements");
  const aisle = measured(scene, "aisle-clearance");
  assert.equal(aisle.passed, false); assert.ok(aisle.observed > 2.0 && aisle.observed < 2.2, `aisle ${aisle.observed}`);
  assert.equal(scene.diff?.blocking_changes, 1);
  assert.deepEqual(scene.stages?.candidate?.map(s => s.id), ["hall", "line", "machines", "robots", "guards", "storage", "logistics", "sensing"]);
  const coverage = scene.candidate!.checks.find(c => c.id === "camera-coverage") as unknown as { observed: number; rays: unknown[] };
  assert.equal(coverage.observed, 6); assert.equal(coverage.rays.length, 6);
  for (const file of ["preview.png", "inspection.png"]) {
    const png = await app.inject({ url: `/api/scenes/${scene.id}/files/candidate/${file}`, headers: { host } });
    assert.equal(png.statusCode, 200); assert.equal(png.rawPayload.subarray(1, 4).toString(), "PNG");
  }
  const glb = await app.inject({ url: `/api/scenes/${scene.id}/files/candidate/scene.glb`, headers: { host } });
  assert.equal(glb.rawPayload.subarray(0, 4).toString(), "glTF");
  const json = JSON.parse(glb.rawPayload.subarray(20, 20 + glb.rawPayload.readUInt32LE(12)).toString()) as { animations?: unknown[]; nodes: unknown[] };
  assert.ok((json.animations?.length ?? 0) > 0, "Final GLB carries the native animation"); assert.ok(json.nodes.length > 100);
  const missing = await app.inject({ url: `/api/scenes/${scene.id}/files/baseline/inspection.png`, headers: { host } });
  assert.equal(missing.statusCode, 200, "Baseline plant also has an inspection render");

  let f = await request<Feedback>("POST", "/api/feedback", { runId: scene.id, evidenceKind: "blender-scene", kind: "design-check", checkId: "aisle-clearance", seed: null,
    expected: "AGV aisle clear width at least 2.4 m", observed: `Native rays measure ${aisle.observed} m: larger guards encroach on the aisle`, actorKind: "maintainer" });
  for (const status of ["reproducible", "assigned", "fix-proposed"]) {
    f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status, reason: "Widen the designed aisle to compensate the 4.2 m guards within the footprint" });
  }
  const fixedLayout = { ...compact, aisleWidth: 2.8 };
  const fixed = await request<SceneReview>("POST", `/api/projects/${project.id}/scenes`, { ...first, requestId: randomUUID(), layout: fixedLayout, feedbackId: f.id });
  assert.equal(fixed.state, "completed", fixed.error ?? "native plant failed"); assert.equal(fixed.verdict, "accepted-static-scene");
  assert.ok(measured(fixed, "aisle-clearance").observed >= 2.4 && measured(fixed, "footprint-area").observed <= 650);
  f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason: "New native plant production passes the aisle check", recheckRunId: fixed.id });
  f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "Aisle corrected; static geometry only, no safety certification" });
  const report = { schema: "pai-plant-e2e-1", checkedAt: new Date().toISOString(), result: "passed", blenderVersion: scene.candidate!.blenderVersion,
    rejected: { verdict: scene.verdict, aisle: aisle.observed, blocking: scene.diff!.blocking_changes },
    fixed: { verdict: fixed.verdict, aisle: measured(fixed, "aisle-clearance").observed, footprint: measured(fixed, "footprint-area").observed },
    feedbackStatus: f.status, objects: (scene.candidate as { derived?: { objects: number } }).derived?.objects };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "plant-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
