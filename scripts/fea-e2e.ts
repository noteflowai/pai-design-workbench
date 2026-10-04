/**
 * Native structural loop: frozen structural requirements → CadQuery part → Gmsh + CalculiX → measured
 * deflection/stress checks inside the ordinary CAD review (baseline, EvalArc, verdict, files with digests).
 * Shows the decision physics changes: the CAD-only lightest feasible bracket (t = 3 mm) is too flexible.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, DEFAULT_STRUCTURAL, type CadReview } from "../src/cad.js";
import type { Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.cadquery && config.physicsPython && config.ccx, "Run npm run setup:cad and npm run setup:physics");
const state = join(config.state, "fea-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const post = async <T>(url: string, payload: unknown) => {
  const r = await app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
const requirements = { ...DEFAULT_CAD_REQUIREMENTS, structural: DEFAULT_STRUCTURAL };
const check = (c: CadReview, id: string) => c.candidate!.checks.find(x => x.id === id) as unknown as { passed: boolean; observed: number; required: number };
try {
  const project = await post<Project>("/api/projects", { title: "Stiff NEMA 17 bracket", intendedDecision: "Lighten without losing stiffness under belt load",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const review = (variant: string, parameters?: unknown) => post<CadReview>(`/api/projects/${project.id}/cad`,
    { requestId: randomUUID(), projectRevision: 1, variant, requirements, ...(parameters ? { parameters } : {}) });
  const t0 = Date.now();
  const thin = await review("parametric", { thickness: 3, width: 60, plateHeight: 46, pilotBore: 22.5 });
  assert.equal(thin.state, "completed", thin.error ?? "native CAD review failed");
  assert.equal(thin.baseline!.checks.length, 9);
  assert.ok(thin.baseline!.checks.every(c => c.passed), "reference bracket passes geometry and FEA");
  assert.equal(check(thin, "min-wall").passed, true, "geometry alone accepts t = 3 mm");
  assert.equal(check(thin, "max-deflection").passed, false, "FEA rejects it on stiffness");
  assert.equal(thin.verdict, "rejected"); assert.equal(thin.diff?.blocking_changes, 1);
  assert.ok(thin.fea?.candidate && thin.fea.candidate.convergence.axisDisplacement < 0.05, "deflection converges within 5 % between meshes");
  for (const f of ["fea.json", "fea.glb", "bracket-fine.inp", "bracket-fine.frd"]) {
    const r = await app.inject({ url: `/api/cad/${thin.id}/files/candidate/${f}`, headers: { host } });
    assert.equal(r.statusCode, 200, f);
  }
  const glb = await app.inject({ url: `/api/cad/${thin.id}/files/candidate/fea.glb`, headers: { host } });
  assert.equal(glb.rawPayload.subarray(0, 4).toString(), "glTF");
  if (config.blender) {
    // Result picture for visual review: native Blender render of the solver's colour field, recorded by digest.
    assert.ok(thin.files["candidate/fea.png"], "fea.png is a recorded file when Blender is configured");
    const png = await app.inject({ url: `/api/cad/${thin.id}/files/candidate/fea.png`, headers: { host } });
    assert.equal(png.statusCode, 200); assert.equal(png.headers["content-type"], "image/png");
    assert.equal(png.rawPayload.subarray(1, 4).toString(), "PNG");
    assert.ok(thin.receipts.some(r => r.adapter === "blender-render" && r.exitCode === 0));
  }
  const report = { schema: "pai-fea-e2e-1", checkedAt: new Date().toISOString(), result: "passed", seconds: Math.round((Date.now() - t0) / 1000),
    solver: thin.fea!.candidate!.solver, mesher: thin.fea!.candidate!.mesher,
    baseline: { deflectionMm: check({ candidate: thin.baseline } as CadReview, "max-deflection").observed, stressMPa: check({ candidate: thin.baseline } as CadReview, "max-stress").observed },
    thin: { verdict: thin.verdict, minWall: check(thin, "min-wall").observed, deflectionMm: check(thin, "max-deflection").observed, stressMPa: check(thin, "max-stress").observed,
      convergence: thin.fea!.candidate!.convergence, elements: thin.fea!.candidate!.meshes.fine.elements } };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "fea-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
