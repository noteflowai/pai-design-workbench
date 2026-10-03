/**
 * Native robot-workcell loop (MuJoCo): a faster cell whose guards were pulled in to save floor space collides;
 * EvalArc flags the lost checks and the paired seeds; the corrected cell (guards back, same speed) passes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_ROBOT_REQUIREMENTS, ROBOT_REFERENCE, type SceneReview } from "../src/scenes.js";
import type { Feedback, Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.physicsPython, "Run npm run setup:physics");
const state = join(config.state, "robot-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const req = async <T>(method: "POST" | "PATCH", url: string, payload: unknown) => {
  const r = await app.inject({ method, url, payload: JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
const observed = (s: SceneReview, id: string) => (s.candidate!.checks.find(c => c.id === id) as unknown as { passed: boolean; observed: number });
try {
  const project = await req<Project>("POST", "/api/projects", { title: "Faster pick-and-place cell", intendedDecision: "Cut cycle time without losing reach or safety clearance",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const requirements = { ...DEFAULT_ROBOT_REQUIREMENTS, maxCycleSeconds: 5 };
  const tight = { ...ROBOT_REFERENCE, speedFraction: 0.75, guardClearance: 0.12 };
  const first = await req<SceneReview>("POST", `/api/projects/${project.id}/scenes`, { requestId: randomUUID(), projectRevision: 1, variant: "robot-cell", cell: tight, requirements });
  assert.equal(first.state, "completed", first.error ?? "robot simulation failed");
  assert.equal(first.verdict, "rejected");
  assert.equal(first.baseline!.checks.find(c => c.id === "collision-free")!.passed, true);
  assert.equal(observed(first, "collision-free").passed, false, "pulled-in guards are hit");
  assert.ok(observed(first, "cycle-time").passed, "the faster cell meets the 5 s cycle");
  assert.ok((first.diff?.blocking_changes ?? 0) >= 1);
  const glb = await app.inject({ url: `/api/scenes/${first.id}/files/candidate/robot.glb`, headers: { host } });
  assert.equal(glb.rawPayload.subarray(0, 4).toString(), "glTF");
  const xml = await app.inject({ url: `/api/scenes/${first.id}/files/candidate/scene.xml`, headers: { host } });
  assert.match(xml.body, /<mujoco model="pai-workcell">/);
  let f = await req<Feedback>("POST", "/api/feedback", { runId: first.id, evidenceKind: "blender-scene", kind: "design-check", checkId: "collision-free", seed: null,
    expected: "No arm contact with guards", observed: "Elbow contacts the pulled-in guard on every seed", actorKind: "maintainer" });
  for (const status of ["reproducible", "assigned", "fix-proposed"]) f = await req<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status, reason: "Restore guard clearance; keep the faster speed" });
  const fixed = await req<SceneReview>("POST", `/api/projects/${project.id}/scenes`, { requestId: randomUUID(), projectRevision: 1, variant: "robot-cell", cell: { ...tight, guardClearance: 0.3 }, requirements, feedbackId: f.id });
  assert.equal(fixed.verdict, "accepted-static-scene", fixed.error ?? JSON.stringify(fixed.candidate?.checks));
  f = await req<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason: "New MuJoCo run is collision-free at 75 % speed", recheckRunId: fixed.id });
  f = await req<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "Guard clearance restored; simulation only" });
  const report = { schema: "pai-robot-e2e-1", checkedAt: new Date().toISOString(), result: "passed", engine: (first.candidate as { engine?: string }).engine,
    baseline: { cycle: (first.baseline!.checks.find(c => c.id === "cycle-time") as unknown as { observed: number }).observed, verdictOfBaselineChecks: first.baseline!.checks.map(c => `${c.id}=${c.passed}`) },
    rejected: { cycle: observed(first, "cycle-time").observed, collisionFreeSeeds: observed(first, "collision-free").observed, blocking: first.diff!.blocking_changes },
    fixed: { cycle: observed(fixed, "cycle-time").observed, successRate: observed(fixed, "success-rate").observed, verdict: fixed.verdict }, feedback: f.status };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "robot-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
