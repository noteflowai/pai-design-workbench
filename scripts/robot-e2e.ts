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
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
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
  // CAD → MJCF/USD: mount the accepted CAD part of this project on the gripper; mass comes from the exact mesh volume.
  let toolReport: unknown = "skipped: CadQuery not configured";
  let robotsReport: unknown = "skipped: Strands Robots not configured (tools/setup_robots.py)";
  if (config.cadquery) {
    const cad = await req<CadReview>("POST", `/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "reference", requirements: DEFAULT_CAD_REQUIREMENTS });
    assert.equal(cad.verdict, "accepted-cad-part", cad.error ?? "CAD review failed");
    const mounted = await req<SceneReview>("POST", `/api/projects/${project.id}/scenes`, { requestId: randomUUID(), projectRevision: 1, variant: "robot-cell",
      cell: { ...tight, guardClearance: 0.3 }, requirements, tool: { cadReviewId: cad.id } });
    assert.equal(mounted.state, "completed", mounted.error ?? "mounted cell failed");
    const t = mounted.tool!;
    assert.equal(t.stlSha256, cad.files["candidate/part.stl"], "the exact reviewed STL is mounted");
    assert.ok(Math.abs(t.mujocoMassG! - t.brepMassG) / t.brepMassG < 0.03, `mesh mass ${t.mujocoMassG} g vs B-Rep ${t.brepMassG} g`);
    assert.ok(mounted.usd && mounted.usd.validators > 20 && mounted.usd.joints.filter(j => !j.startsWith("fixed_")).length === 6 && mounted.usd.joints.includes("fixed_cad_tool"));
    const mjcf = await app.inject({ url: `/api/scenes/${mounted.id}/files/candidate/scene.xml`, headers: { host } });
    assert.match(mjcf.body, /<mesh name="cad-tool" file="tool.stl"/); assert.doesNotMatch(String(mjcf.body), /\/home\/|\/var\//, "portable MJCF without local paths");
    const usda = await app.inject({ url: `/api/scenes/${mounted.id}/files/candidate/scene.usda`, headers: { host } });
    assert.match(usda.body, /^#usda 1\.0/); assert.match(usda.body, /PhysicsRevoluteJoint/); assert.match(usda.body, /PhysicsArticulationRootAPI/);
    if (config.newtonPython) {
      // The exported USD is what Newton / Isaac Lab users receive: one articulation, same masses and kinematics as the MJCF.
      const n = mounted.usd!.newton!;
      assert.ok("passed" in n && n.passed, JSON.stringify(n));
      assert.ok(n.fkPositionM < 1e-4 && mounted.files["candidate/newton.json"]);
    }
    if (config.robotsPython && config.robotsAssets) {
      // Strands Robots loads the official UR5e (pinned Menagerie, offline) and compares it with the simulated arm. A
      // conformance record: kinematics must agree; the known link-mass difference is reported, not hidden.
      const r = mounted.robots!;
      assert.ok("passed" in r, JSON.stringify(r));
      const check = (id: string) => r.checks.find(c => c.id === id)!;
      for (const id of ["joints", "joint-limits", "fk-flange", "reach"]) assert.ok(check(id).passed, `${id}: ${JSON.stringify(check(id))}`);
      assert.ok(mounted.files["candidate/robots.json"] && mounted.receipts.some(x => x.adapter === "strands-robots" && x.exitCode === 0));
      robotsReport = { strandsRobots: r.strandsRobots, menagerieCommit: r.menagerieCommit, checks: r.checks.map(c => ({ id: c.id, passed: c.passed, observed: c.observed })) };
    }
    const stl = await app.inject({ url: `/api/scenes/${mounted.id}/files/candidate/tool.stl`, headers: { host } });
    assert.equal(stl.statusCode, 200);
    const refused = await app.inject({ method: "POST", url: `/api/projects/${project.id}/scenes`, headers: { host, "content-type": "application/json" },
      payload: JSON.stringify({ requestId: randomUUID(), projectRevision: 1, variant: "robot-cell", cell: tight, requirements, tool: { cadReviewId: randomUUID() } }) });
    assert.match(refused.body, /TOOL_NOT_ACCEPTED/, "only an accepted CAD part of this project can be mounted");
    const wrist = (s: SceneReview) => (s.candidate as unknown as { checks: { id: string; observed: number }[] }).checks.find(c => c.id === "cycle-time")!.observed;
    toolReport = { cadReview: cad.id, brepMassG: t.brepMassG, mujocoMassG: t.mujocoMassG, payloadKg: t.payloadKg, verdict: mounted.verdict, cycle: wrist(mounted), usd: mounted.usd };
  }
  const report = { schema: "pai-robot-e2e-1", strandsRobots: robotsReport, checkedAt: new Date().toISOString(), result: "passed", engine: (first.candidate as { engine?: string }).engine,
    baseline: { cycle: (first.baseline!.checks.find(c => c.id === "cycle-time") as unknown as { observed: number }).observed, verdictOfBaselineChecks: first.baseline!.checks.map(c => `${c.id}=${c.passed}`) },
    rejected: { cycle: observed(first, "cycle-time").observed, collisionFreeSeeds: observed(first, "collision-free").observed, blocking: first.diff!.blocking_changes },
    fixed: { cycle: observed(fixed, "cycle-time").observed, successRate: observed(fixed, "success-rate").observed, verdict: fixed.verdict }, feedback: f.status, tool: toolReport };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "robot-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
