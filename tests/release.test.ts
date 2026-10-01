import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";
import type { CadReview } from "../src/cad.js";
import { DEFAULT_CAD_REQUIREMENTS } from "../src/cad.js";

const task = { title: "Bracket release", intendedDecision: "Release a bracket only after failures are dispositioned",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
const ids = ["solid-valid", "nema17-interface", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope"];
const checks = (variant: string, failing: string[]) => ({ schema: "pai-cad-checks-1", variant, cadquery: "2.8.0", ocp: "7.9.3.1.1", units: "mm", mass: 40, volume: 1,
  boundingBox: [1, 1, 1], checks: ids.map(id => ({ id, passed: !failing.includes(id) })), scope: "parametric-part-geometry", physicalValidation: false });
const cad = (projectId: string, variant: string, failing: string[], extra: Partial<CadReview> = {}): CadReview => ({
  id: randomUUID(), projectId, projectRevision: 1, request: { requestId: randomUUID(), projectRevision: 1, variant: variant as "reference", requirements: DEFAULT_CAD_REQUIREMENTS },
  requirementDigest: "x", state: "completed", createdAt: new Date().toISOString(), verdict: failing.length ? "rejected" : "accepted-cad-part",
  baseline: checks("reference", []) as CadReview["baseline"], candidate: checks(variant, failing) as CadReview["candidate"],
  receipts: [], sourceDigests: {}, files: {}, scope: "parametric-part-geometry", physicalValidation: false, ...extra });

test("release gate: admission, approval re-check, supersession on requirement revision and version history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-release-"));
  const config = { ...configuration(), state: dir };
  const { app, store, workbench } = await createApp(config, {} as Adapters);
  const h = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: h, payload: payload === undefined ? undefined : JSON.stringify(payload) }); return { status: r.statusCode, body: r.json() };
  };
  try {
    const p = workbench.createProject(task);
    const light = cad(p.id, "lightweight", ["min-wall"]); store.insert("cad-review", light);
    const fixed = cad(p.id, "reference", []); store.insert("cad-review", fixed);
    const base = (runId: string) => ({ requestId: randomUUID(), projectRevision: 1, evidenceKind: "cad-part", runId, title: "NEMA 17 bracket" });
    // A rejected run is never admissible.
    let r = await call("POST", `/api/projects/${p.id}/releases`, base(light.id));
    assert.equal(r.status, 422); assert.match(r.body.message, /结论：拒绝/);
    // A passing run is blocked while a retained failure has no closed feedback.
    const adm = await call("GET", `/api/projects/${p.id}/admission?kind=cad-part&runId=${fixed.id}`);
    assert.equal(adm.body.find((c: { id: string }) => c.id === "failures-dispositioned").passed, false);
    r = await call("POST", `/api/projects/${p.id}/releases`, base(fixed.id));
    assert.equal(r.status, 422); assert.match(r.body.message, /失败案例/);
    let f = workbench.createFeedback({ runId: light.id, evidenceKind: "cad-part", kind: "design-check", checkId: "min-wall", seed: null,
      expected: "≥ 3 mm", observed: "2.5 mm plates", actorKind: "maintainer" });
    r = await call("POST", `/api/projects/${p.id}/releases`, base(fixed.id));
    assert.equal(r.status, 422); assert.match(r.body.message, /未关闭/);
    for (const status of ["reproducible", "assigned", "fix-proposed"] as const) f = workbench.transitionFeedback(f.id, { expectedRevision: f.revision, status, reason: "Restore 4 mm plates" });
    const recheck = cad(p.id, "reference", [], { feedbackId: f.id }); store.insert("cad-review", recheck);
    f = workbench.transitionFeedback(f.id, { expectedRevision: f.revision, status: "rechecked", reason: "Recheck passes", recheckRunId: recheck.id });
    f = workbench.transitionFeedback(f.id, { expectedRevision: f.revision, status: "closed", reason: "Closed with retained failure record" });
    r = await call("POST", `/api/projects/${p.id}/releases`, base(fixed.id));
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.maturity, "in-review"); assert.equal(r.body.number, "R1");
    assert.equal(r.body.physicalValidation, false); assert.ok(r.body.admission.every((c: { passed: boolean }) => c.passed));
    const r1 = r.body;
    assert.equal((await call("POST", `/api/projects/${p.id}/releases`, base(fixed.id))).status, 409, "only one candidate in review");
    // Approval is a compare-and-swap with a reason; the lifecycle reflects the released maturity.
    assert.equal((await call("PATCH", `/api/projects/${p.id}/releases/${r1.id}`, { expectedRevision: 9, decision: "approve", reason: "Reviewed" })).status, 409);
    r = await call("PATCH", `/api/projects/${p.id}/releases/${r1.id}`, { expectedRevision: 1, decision: "approve", reason: "All admission checks pass" });
    assert.equal(r.body.maturity, "released"); assert.equal(r.body.history.at(-1).actor, "local-maintainer");
    let state = (await call("GET", "/api/state")).body;
    assert.equal(state.lifecycles[p.id].maturity.number, "R1"); assert.equal(state.lifecycles[p.id].stages.at(-1).status, "done");
    assert.equal((await call("PATCH", `/api/projects/${p.id}/releases/${r1.id}`, { expectedRevision: 2, decision: "reject", reason: "Too late" })).status, 409);
    // A second release supersedes the first.
    r = await call("POST", `/api/projects/${p.id}/releases`, { ...base(recheck.id), title: "Bracket rev B" });
    assert.equal(r.body.number, "R2");
    await call("PATCH", `/api/projects/${p.id}/releases/${r.body.id}`, { expectedRevision: 1, decision: "approve", reason: "Rev B" });
    state = (await call("GET", "/api/state")).body;
    assert.deepEqual(state.releases.map((x: { number: string; maturity: string }) => `${x.number}:${x.maturity}`), ["R1:superseded", "R2:released"]);
    // Revising requirements supersedes the release; old versions stay readable with their own digests.
    const rev = await call("PATCH", `/api/projects/${p.id}`, { ...task, requirements: { ...task.requirements, minSuccessRate: 0.7 }, expectedRevision: 1 });
    assert.equal(rev.body.revision, 2);
    state = (await call("GET", "/api/state")).body;
    assert.ok(state.releases.every((x: { maturity: string }) => x.maturity === "superseded"));
    assert.equal(state.lifecycles[p.id].maturity.state, "superseded-only");
    const versions = (await call("GET", `/api/projects/${p.id}/versions`)).body;
    assert.deepEqual(versions.map((v: { revision: number; requirements: { minSuccessRate: number } }) => [v.revision, v.requirements.minSuccessRate]), [[1, 0.5], [2, 0.7]]);
    assert.notEqual(versions[0].requirementDigest, versions[1].requirementDigest);
    // Bound to the old revision now: new candidates on the old run are refused.
    r = await call("POST", `/api/projects/${p.id}/releases`, { ...base(fixed.id), projectRevision: 2 });
    assert.equal(r.status, 422); assert.match(r.body.message, /当前 v2/);
    assert.equal((await call("POST", `/api/projects/${p.id}/releases`, { ...base(fixed.id), approvedBy: "x" })).status, 400);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
