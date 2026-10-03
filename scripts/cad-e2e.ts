import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { command } from "../src/adapters.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import type { Feedback, Project } from "../src/contracts.js";

/** Native CadQuery/OCCT parametric part loop: failure, feedback, unfixed-closure guard, fix, STEP re-import. */
const config = configuration();
assert.ok(config.cadquery, "Run npm run setup:cad or set PAI_CADQUERY_PYTHON");
const state = join(config.state, "cad-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const request = async <T>(method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
try {
  const project = await request<Project>("POST", "/api/projects", { title: "NEMA 17 motor-mount bracket", intendedDecision: "Accept a lighter bracket only if wall, interface and assembly checks still pass",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const requirements = DEFAULT_CAD_REQUIREMENTS;
  const original = { requestId: randomUUID(), projectRevision: 1, variant: "lightweight", requirements };
  const light = await request<CadReview>("POST", `/api/projects/${project.id}/cad`, original);
  assert.equal(light.state, "completed", light.error ?? ""); assert.equal(light.verdict, "rejected");
  assert.ok(light.baseline!.checks.every(c => c.passed), "reference parameters satisfy every check");
  assert.deepEqual(light.candidate!.checks.filter(c => !c.passed).map(c => c.id), ["min-wall"]);
  assert.equal(light.diff?.blocking_changes, 1);
  assert.ok(light.candidate!.mass < light.baseline!.mass, "lightweight variant is lighter");
  assert.equal((await request<CadReview>("POST", `/api/projects/${project.id}/cad`, original)).id, light.id);
  assert.deepEqual(light.stages?.candidate?.map(s => s.id), ["base", "plate", "ribs", "nema", "mount", "motor"]);
  const stream = await app.inject({ url: `/api/live/${original.requestId}`, headers });
  const events = stream.body.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)) as { kind: string });
  assert.equal(events.filter(e => e.kind === "stage").length, 12); assert.equal(events.at(-1)?.kind, "done");
  for (const file of ["part.step", "part.stl", "assembly.glb", "drawing.svg"]) {
    const r = await app.inject({ url: `/api/cad/${light.id}/files/candidate/${file}`, headers });
    assert.equal(r.statusCode, 200, file);
    if (file === "drawing.svg") assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
    if (file === "part.step") assert.match(r.body.slice(0, 200), /ISO-10303-21/);
    if (file === "assembly.glb") assert.equal(r.rawPayload.subarray(0, 4).toString(), "glTF");
  }
  const others: Record<string, string[]> = {};
  for (const variant of ["undersize-bore", "compact"]) {
    const r = await request<CadReview>("POST", `/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant, requirements });
    assert.equal(r.verdict, "rejected");
    others[variant] = r.candidate!.checks.filter(c => !c.passed).map(c => c.id);
  }
  assert.deepEqual(others, { "undersize-bore": ["nema17-interface", "motor-interference"], compact: ["hole-edge-distance"] });

  let f = await request<Feedback>("POST", "/api/feedback", { runId: light.id, evidenceKind: "cad-part", kind: "design-check", checkId: "min-wall", seed: null,
    expected: "Plates at least 3 mm thick", observed: "Lightweight variant has 2.5 mm plates", actorKind: "maintainer" });
  const wrong = await app.inject({ method: "POST", url: "/api/feedback", headers, payload: { runId: light.id, evidenceKind: "cad-part", kind: "design-check",
    checkId: "mass", seed: null, expected: "x", observed: "mass passes, cannot be a failure", actorKind: "maintainer" } });
  assert.equal(wrong.statusCode, 409);
  for (const status of ["reproducible", "assigned", "fix-proposed"]) {
    f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status, reason: "Restore 4 mm plates while keeping the same part requirements" });
  }
  const unfixed = await request<CadReview>("POST", `/api/projects/${project.id}/cad`, { ...original, requestId: randomUUID(), feedbackId: f.id });
  const denied = await app.inject({ method: "PATCH", url: `/api/feedback/${f.id}`, headers,
    payload: { expectedRevision: f.revision, status: "rechecked", reason: "Same thin plates must remain open", recheckRunId: unfixed.id } });
  assert.equal(denied.statusCode, 409); assert.equal(denied.json().error, "ISSUE_NOT_FIXED");
  const changed = await app.inject({ method: "POST", url: `/api/projects/${project.id}/cad`, headers,
    payload: { ...original, requestId: randomUUID(), variant: "reference", requirements: { ...requirements, minWallMm: 2 }, feedbackId: f.id } });
  assert.equal(changed.json().state, "failed"); assert.match(changed.json().error, /INVALID_RECHECK/);
  const fixed = await request<CadReview>("POST", `/api/projects/${project.id}/cad`, { ...original, requestId: randomUUID(), variant: "reference", feedbackId: f.id });
  assert.equal(fixed.verdict, "accepted-cad-part");
  f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason: "New native CAD production passes min-wall", recheckRunId: fixed.id });
  f = await request<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "Plates restored to 4 mm; nominal geometry only" });

  const reopened = join(state, "reopened.json");
  const opened = await command(config.cadquery!, ["-I", "-W", "ignore", join(config.repository, "native/cad_reopen.py"),
    join(state, "cad", fixed.id, "candidate/part.step"), reopened], config.repository, undefined, 120_000);
  assert.equal(opened.exitCode, 0, opened.stderr);
  const roundtrip = JSON.parse(await readFile(reopened, "utf8"));
  assert.equal(roundtrip.valid, true); assert.equal(roundtrip.solids, 1);
  assert.ok(Math.abs(roundtrip.volume - fixed.candidate!.volume) < 0.01 * fixed.candidate!.volume, "STEP re-import preserves volume within 1%");
  assert.deepEqual(roundtrip.holeDiameters, [3.4, 5.5, 22.5]);
  assert.deepEqual(fixed.candidate!.boundingBox, [60, 30, 50], "staged GLB meshing must not inflate nominal CAD bounds");
  assert.deepEqual(roundtrip.boundingBox, fixed.candidate!.boundingBox, "STEP geometry retains the measured envelope");
  const boundary = await request<CadReview>("POST", `/api/projects/${project.id}/cad`, {
    requestId: randomUUID(), projectRevision: 1, variant: "reference",
    requirements: { ...requirements, maxEnvelopeMm: [60, 30, 50] },
  });
  assert.equal(boundary.verdict, "accepted-cad-part", "nominal envelope at the exact requirement boundary must pass after staged exports");
  assert.ok(boundary.candidate!.checks.every(c => c.passed));
  // DFM (3-axis milling) frozen as a requirement: measured on the B-Rep, mapped into the same checks and EvalArc.
  const dfmRun = await request<CadReview>("POST", `/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "compact",
    requirements: { ...requirements, dfm: { maxSetups: 2, maxUnitCostEur: 16 } } });
  assert.equal(dfmRun.state, "completed", dfmRun.error ?? "DFM review failed");
  const dfmCheck = (w: "baseline" | "candidate", id: string) => (dfmRun[w]!.checks.find(c => c.id === id) as unknown as { passed: boolean; observed: number });
  assert.equal(dfmCheck("candidate", "machining-setups").observed, 2, "the bracket needs two setups (+Y face, +Z base)");
  assert.equal(dfmCheck("baseline", "unit-cost").passed, false, "the larger reference bracket is over the 16 EUR target");
  assert.equal(dfmCheck("candidate", "unit-cost").passed, true, "the compact bracket is under the 16 EUR target");
  assert.ok(dfmRun.files["candidate/dfm.json"]);
  const dfmReport = { setups: dfmCheck("candidate", "machining-setups").observed, unitCostEur: { reference: dfmCheck("baseline", "unit-cost").observed, compact: dfmCheck("candidate", "unit-cost").observed },
    verdict: dfmRun.verdict };
  const report = { schema: "pai-cad-e2e-1", checkedAt: new Date().toISOString(), result: "passed",
    cadquery: fixed.candidate!.cadquery, ocp: fixed.candidate!.ocp, part: "NEMA 17 motor-mount bracket (6061 aluminium, nominal)",
    candidates: { lightweight: ["min-wall"], ...others }, referenceMassG: fixed.candidate!.mass, lightweightMassG: light.candidate!.mass,
    feedbackStatus: f.status, preventedUnfixedClosure: true, rejectedChangedRequirementsRecheck: true, stageEvents: 12, stepReimport: roundtrip,
    nominalEnvelopeBoundaryAccepted: true,
    nativeArtifactKinds: ["step", "stl", "glb", "assembly-glb", "svg-drawing", "native-checks-json"],
    dfm: dfmReport, physicalValidation: false, feaPerformed: false, toleranceStackUp: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/cad-e2e.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
