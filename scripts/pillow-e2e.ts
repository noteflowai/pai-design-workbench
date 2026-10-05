/**
 * Second part family end to end: 6202 pillow-block housing through the same CAD review, DFM and EvalArc as the
 * bracket. Each single-fault preset fails exactly its check; a frozen DFM requirement measures the same B-Rep.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { FAMILY_DEFAULTS, type CadReview } from "../src/cad.js";
import type { Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.cadquery, "Run npm run setup:cad");
const state = join(config.state, "pillow-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const post = async <T>(url: string, payload: unknown, status = 200) => {
  const r = await app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, status, r.body); return r.json() as T;
};
const failed = (c: CadReview) => c.candidate!.checks.filter(x => !x.passed).map(x => x.id);
try {
  const t0 = Date.now();
  const project = await post<Project>("/api/projects", { title: "6202 pillow block", intendedDecision: "A housing that seats a 6202 in H7 and bolts down with M8",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const requirements = FAMILY_DEFAULTS["pillow-block"];
  const review = (variant: string, extra: Record<string, unknown> = {}) => post<CadReview>(`/api/projects/${project.id}/cad`,
    { requestId: randomUUID(), projectRevision: 1, variant, requirements: { ...requirements, ...extra } });
  const expected: Record<string, string[]> = { "pillow-block": [], "pillow-block-light": ["min-wall"], "pillow-block-compact": ["hole-edge-distance"], "pillow-block-tight": ["bearing-seat"] };
  const results: Record<string, unknown> = {};
  for (const [variant, fails] of Object.entries(expected)) {
    const r = await review(variant);
    assert.equal(r.state, "completed", r.error ?? variant);
    assert.deepEqual(failed(r), fails, `${variant}: ${JSON.stringify(r.candidate!.checks.filter(c => !c.passed))}`);
    assert.ok(r.baseline!.checks.every(c => c.passed), "the 6202 reference passes its own checks");
    assert.equal(r.diff!.blocking_changes, fails.length);
    results[variant] = { verdict: r.verdict, mass: r.candidate!.mass, failed: fails, wall: (r.candidate!.checks.find(c => c.id === "min-wall") as { observed?: number }).observed };
  }
  // DFM on the second family: same native analysis, measured on this B-Rep.
  const dfm = await review("pillow-block", { dfm: { maxSetups: 3, maxUnitCostEur: 40 } });
  assert.equal(dfm.verdict, "accepted-cad-part", JSON.stringify(dfm.candidate!.checks.filter(c => !c.passed)));
  assert.equal(dfm.state, "completed", dfm.error ?? "dfm");
  const d = (id: string) => dfm.candidate!.checks.find(c => c.id === id) as unknown as { passed: boolean; observed: number };
  results.dfm = { verdict: dfm.verdict, setups: d("machining-setups").observed, fastenerAccess: d("fastener-access").observed, unitCostEur: d("unit-cost").observed };
  // Generated CadQuery code for this family (the reference template) runs in the OS sandbox and is measured with the
  // pillow-block checks; a revised seat Ø outside H7 is caught by the same check as the preset.
  const state0 = (await app.inject({ url: "/api/state", headers: { host } })).json();
  const template = state0.capabilities.cad.generatedCode?.templates?.["pillow-block"] as string | undefined;
  if (state0.capabilities.cad.generatedCode?.available && template) {
    const code = (src: string) => post<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "generated", family: "pillow-block",
      requirements, source: { language: "cadquery-2.8", code: src } });
    const ok = await code(template);
    assert.equal(ok.state, "completed", ok.error ?? "generated");
    assert.deepEqual(failed(ok), [], JSON.stringify(ok.candidate!.checks.filter(c => !c.passed)));
    assert.ok(ok.candidate!.checks.some(c => c.id === "bearing-seat") && ok.sandbox?.status === "ok");
    const tight = await code(template.replace("SEAT, SEAT_LEN = 35.012, 11.0", "SEAT, SEAT_LEN = 34.96, 11.0"));
    assert.deepEqual(failed(tight), ["bearing-seat"]);
    results.generated = { template: { verdict: ok.verdict, mass: ok.candidate!.mass, isolation: ok.sandbox!.isolation.length }, seatOutsideH7: { verdict: tight.verdict, failed: failed(tight) } };
  }
  // Bracket-only lanes are refused for this family, before anything runs.
  await post("/api/projects/" + project.id + "/cad", { requestId: randomUUID(), projectRevision: 1, variant: "pillow-block",
    requirements: { ...requirements, structural: { forceN: 60, leverMm: 50, safetyFactor: 2, maxDeflectionMm: 0.06 } } }, 400);
  const report = { schema: "pai-pillow-e2e-1", checkedAt: new Date().toISOString(), result: "passed", seconds: Math.round((Date.now() - t0) / 1000), results, physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "pillow-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
