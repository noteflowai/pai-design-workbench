import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, FAMILY_DEFAULTS, PILLOW_STRUCTURAL, type CadReview } from "../src/cad.js";
import { pointRequest, type CadSweep } from "../src/sweep.js";
import type { Project } from "../src/contracts.js";

/**
 * Native design-space sweep: grid points equal the presets they coincide with, the summary is recomputed,
 * the lightest feasible point becomes a normal parametric review with provenance, and forged provenance is refused.
 */
const config = configuration();
assert.ok(config.cadquery, "Run npm run setup:cad or set PAI_CADQUERY_PYTHON");
const state = join(config.state, "cad-sweep-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const call = async (method: "POST" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers });
  return { status: r.statusCode, body: r.json() };
};
const ok = async <T>(url: string, payload: unknown) => { const r = await call("POST", url, payload); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as T; };
try {
  const project = await ok<Project>("/api/projects", { title: "Bracket design space", intendedDecision: "Find the lightest bracket that keeps every check",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const grid = { thickness: [2.5, 3, 4], width: [50, 60], plateHeight: [43.5, 46], pilotBore: [22.5] };
  const t0 = Date.now();
  const sweep = await ok<CadSweep>(`/api/projects/${project.id}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS, grid });
  const seconds = Math.round((Date.now() - t0) / 1000);
  assert.equal(sweep.state, "completed", sweep.error ?? ""); assert.equal(sweep.result!.points.length, 12);
  const at = (t: number, w: number, h: number) => sweep.result!.points.find(p => p.parameters.thickness === t && p.parameters.width === w && p.parameters.plateHeight === h)!;

  // Points that coincide with presets reproduce the preset reviews check by check.
  const presets: Record<string, [number, number, number]> = { reference: [4, 60, 46], lightweight: [2.5, 60, 46], compact: [4, 50, 43.5] };
  for (const [variant, [t, w, h]] of Object.entries(presets)) {
    const review = await ok<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant, requirements: DEFAULT_CAD_REQUIREMENTS });
    const point = at(t, w, h);
    assert.deepEqual(point.checks!.map(c => [c.id, c.passed, c.observed]), review.candidate!.checks.map(c => [c.id, c.passed, c.observed]), variant);
    assert.equal(point.mass, review.candidate!.mass, variant);
  }
  const feasible = sweep.result!.points.filter(p => p.feasible).map(p => p.index);
  const lightest = sweep.result!.points.find(p => p.index === sweep.result!.lightestFeasible)!;
  assert.deepEqual([lightest.parameters.thickness, lightest.parameters.width, lightest.parameters.plateHeight], [3, 60, 46], "3 mm plates are the lightest point keeping every check");
  assert.ok(lightest.mass! < at(4, 60, 46).mass!, "lighter than the reference");
  assert.ok(sweep.pareto!.includes(lightest.index) && sweep.pareto!.every(i => feasible.includes(i)));
  assert.deepEqual(at(2.5, 50, 43.5).failed, ["min-wall", "hole-edge-distance"]);

  // The chosen point becomes a normal review: baseline, EvalArc, STEP, provenance.
  const chosen = await ok<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric",
    requirements: DEFAULT_CAD_REQUIREMENTS, parameters: lightest.parameters, fromSweep: { sweepId: sweep.id, point: lightest.index } });
  assert.equal(chosen.verdict, "accepted-cad-part"); assert.equal(chosen.diff?.blocking_changes, 0);
  assert.equal(chosen.candidate!.mass, lightest.mass);
  assert.deepEqual(chosen.candidate!.checks.map(c => c.observed), lightest.checks!.map(c => c.observed), "review reproduces the sweep point");
  assert.ok(chosen.files["candidate/part.step"]);
  const forged = await call("POST", `/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric",
    requirements: DEFAULT_CAD_REQUIREMENTS, parameters: { ...lightest.parameters, thickness: 2.5 }, fromSweep: { sweepId: sweep.id, point: lightest.index } });
  assert.equal(forged.status, 422); assert.equal(forged.body.error, "INVALID_SWEEP_POINT");
  const tooBig = await call("POST", `/api/projects/${project.id}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS,
    grid: { thickness: [2, 3, 4, 5, 6, 7], width: [50, 60, 70], plateHeight: [40, 50, 60], pilotBore: [22.5] } });
  assert.equal(tooBig.status, 400, "more than 36 points is refused before any work");
  const outOfBounds = await call("POST", `/api/projects/${project.id}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS,
    grid: { ...grid, thickness: [1] } });
  assert.equal(outOfBounds.status, 400);

  // Second family: the pillow-block grid around the 6202 reference. The reference point reproduces the preset review;
  // the geometry-lightest feasible housing is then a normal candidate on which structural FEA can be frozen.
  const pgrid = { width: [92, 108], depth: [16, 20], baseThickness: [6, 10], boltPitch: [70] };
  const preq = FAMILY_DEFAULTS["pillow-block"];
  const psweep = await ok<CadSweep>(`/api/projects/${project.id}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, family: "pillow-block", requirements: preq, grid: pgrid });
  assert.equal(psweep.state, "completed", psweep.error ?? ""); assert.equal(psweep.result!.points.length, 8); assert.equal(psweep.result!.family, "pillow-block");
  const pref = await ok<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", family: "pillow-block", requirements: preq,
    parameters: { width: 108, depth: 20, baseDepth: 36, axisHeight: 30, baseThickness: 10, boltPitch: 70, seatDiameter: 35.012, shoulderDiameter: 28, crown: 8 } });
  const pat = psweep.result!.points.find(p => p.parameters.width === 108 && p.parameters.depth === 20 && p.parameters.baseThickness === 10)!;
  assert.deepEqual(pat.checks!.map(c => [c.id, c.passed, c.observed]), pref.candidate!.checks.map(c => [c.id, c.passed, c.observed]), "pillow sweep point = review");
  const plight = psweep.result!.points.find(p => p.index === psweep.result!.lightestFeasible)!;
  const pchosen = await ok<CadReview>(`/api/projects/${project.id}/cad`, { ...pointRequest(psweep, plight.index, randomUUID(), 1) });
  assert.equal(pchosen.verdict, "accepted-cad-part"); assert.equal(pchosen.candidate!.mass, plight.mass);
  // The geometry-lightest housing with the bearing load frozen: CalculiX decides, as for the bracket (Y1/Y2).
  let pfea: { verdict?: string; failed: string[]; deflectionUm?: number; distortionUm?: number } | undefined;
  if (config.physicsPython && config.ccx) {
    const r = await ok<CadReview>(`/api/projects/${project.id}/cad`, { ...pointRequest(psweep, plight.index, randomUUID(), 1), requirements: { ...preq, structural: PILLOW_STRUCTURAL } });
    assert.equal(r.state, "completed", r.error ?? "pillow fea");
    const v = (id: string) => Number((r.candidate!.checks.find(c => c.id === id) as unknown as { observed: number }).observed) * 1000;
    pfea = { verdict: r.verdict, failed: r.candidate!.checks.filter(c => !c.passed).map(c => c.id), deflectionUm: +v("max-deflection").toFixed(1), distortionUm: +v("bore-distortion").toFixed(2) };
    assert.ok(pfea.failed.every(id => ["max-deflection", "bore-distortion", "max-stress"].includes(id)), "only structural checks can fail on a geometry-feasible point");
  }
  const structural = await call("POST", `/api/projects/${project.id}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, family: "pillow-block",
    requirements: { ...preq, structural: PILLOW_STRUCTURAL }, grid: pgrid });
  assert.equal(structural.status, 400, "a sweep measures geometry only");
  const wrongAxes = await call("POST", `/api/projects/${project.id}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, family: "pillow-block", requirements: preq, grid });
  assert.equal(wrongAxes.status, 400, "bracket axes are refused for the housing");

  const report = { schema: "pai-cad-sweep-e2e-1", checkedAt: new Date().toISOString(), result: "passed", points: 12, seconds, feasible: feasible.length,
    pillowBlock: { points: 8, feasible: psweep.result!.feasibleCount, lightestFeasible: { parameters: plight.parameters, massG: plight.mass }, chosen: pchosen.verdict, withBearingLoad: pfea,
      referencePointReproduced: true, refused: { structuralSweep: 400, bracketAxes: 400 } },
    lightestFeasible: { parameters: lightest.parameters, massG: lightest.mass }, referenceMassG: at(4, 60, 46).mass, pareto: sweep.pareto,
    presetPointsReproduced: Object.keys(presets), chosenReview: { verdict: chosen.verdict, evalarcBlocking: chosen.diff?.blocking_changes },
    refused: { forgedProvenance: "422 INVALID_SWEEP_POINT", over36Points: 400, outOfBounds: 400 }, physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/cad-sweep-e2e.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
