/**
 * Physics optimisation of the 6202 pillow block end to end (npm run test:optimize-pillow):
 * reference + one AI seed + Sobol points, one surrogate round, all solved by CalculiX under the bearing load; the
 * lightest measured feasible housing becomes a formal two-mesh review that must agree with the optimiser's point.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { FAMILY_DEFAULTS, PILLOW_STRUCTURAL, type CadReview } from "../src/cad.js";
import { optimizePointRequest, type CadOptimization } from "../src/optimize.js";
import type { Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.cadquery && config.physicsPython && config.ccx, "Run npm run setup:cad and npm run setup:physics");
const state = join(config.state, "optimize-pillow-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const call = async (url: string, payload: unknown) => { const r = await app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers }); return { status: r.statusCode, body: r.json() }; };
const post = async <T>(url: string, payload: unknown) => { const r = await call(url, payload); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as T; };
const requirements = { ...FAMILY_DEFAULTS["pillow-block"], structural: PILLOW_STRUCTURAL };
try {
  const project = await post<Project>("/api/projects", { title: "Lightest 6202 housing", intendedDecision: "Lightest pillow block that keeps the seat round under 1 kN",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const url = `/api/projects/${project.id}/cad-optimizations`;
  // Refused before any work: a bracket load case, BoTorch, the Batch backend, bracket seed axes.
  for (const bad of [{ requirements: { ...requirements, structural: { forceN: 60, leverMm: 50, safetyFactor: 2, maxDeflectionMm: 0.06 } } },
    { strategy: "botorch-qlognehvi" }, { solver: "batch" }, { seeds: [{ parameters: { thickness: 3, width: 60, plateHeight: 46 } }] }]) {
    assert.equal((await call(url, { requestId: randomUUID(), projectRevision: 1, family: "pillow-block", requirements, ...bad })).status, 400, JSON.stringify(bad));
  }
  const t0 = Date.now();
  const run = await post<CadOptimization>(url, { requestId: randomUUID(), projectRevision: 1, family: "pillow-block", requirements,
    budget: { initial: 4, rounds: 1, perRound: 3 },
    seeds: [{ parameters: { width: 96, depth: 18, baseThickness: 8, boltPitch: 62 }, expectedDeflectionMm: 0.0055, expectedMassG: 150,
      rationale: "Thinner base, shorter footprint; (96 - 62) / 2 = 17 >= 13.5 keeps the bolt edge rule" }] });
  assert.equal(run.state, "completed", run.error ?? "optimisation failed");
  const r = run.result!;
  assert.equal(r.family, "pillow-block"); assert.equal(r.points[0].origin, "reference"); assert.equal(r.points[0].feasible, true);
  assert.ok(r.points.every(p => p.fidelity !== "fea" || (p.boreDistortionMm! > 0 && p.deflectionMm! > 0)), "every solved housing has its seat distortion");
  assert.ok(r.lightestFeasible, "a measured feasible housing exists");
  const best = r.points.find(p => p.index === r.lightestFeasible)!;
  assert.ok(best.mass! < r.points[0].mass!, "lighter than the reference");
  const formal = await post<CadReview>(`/api/projects/${project.id}/cad`, optimizePointRequest(run, best.index, randomUUID(), 1));
  assert.equal(formal.state, "completed", formal.error ?? "formal review");
  const v = (id: string) => (formal.candidate!.checks.find(c => c.id === id) as unknown as { observed: number; passed: boolean });
  // The formal review solves two meshes; the optimiser screened on the fine mesh only, so the values agree closely.
  assert.ok(Math.abs(v("bore-distortion").observed - best.boreDistortionMm!) / best.boreDistortionMm! < 0.05, `${v("bore-distortion").observed} vs ${best.boreDistortionMm}`);
  const report = { schema: "pai-optimize-pillow-e2e-1", checkedAt: new Date().toISOString(), result: "passed", seconds: Math.round((Date.now() - t0) / 1000),
    points: r.points.length, solved: r.points.filter(p => p.fidelity === "fea").length, feasible: r.feasibleCount,
    reference: { mass: r.points[0].mass, deflectionMm: r.points[0].deflectionMm, boreDistortionMm: r.points[0].boreDistortionMm },
    recommended: { index: best.index, origin: best.origin, parameters: best.parameters, mass: best.mass, deflectionMm: best.deflectionMm, boreDistortionMm: best.boreDistortionMm },
    formal: { verdict: formal.verdict, deflectionMm: v("max-deflection").observed, boreDistortionMm: v("bore-distortion").observed, convergence: formal.fea?.candidate?.convergence },
    surrogate: { loo: r.rounds[0]?.looMeanAbsError, calibration: r.calibration }, aiSeed: r.aiSeeds[0], physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "optimize-pillow-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
