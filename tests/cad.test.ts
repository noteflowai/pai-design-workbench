import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFromMessage } from "../src/assistant.js";
import { computeLifecycle } from "../src/lifecycle.js";
import { CadRequest, DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import { Store } from "../src/store.js";
import { Workbench } from "../src/service.js";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";
import type { Project } from "../src/contracts.js";

const task = { title: "Bracket", intendedDecision: "Review a parametric motor bracket",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
const ids = ["solid-valid", "nema17-interface", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope"];
const checks = (failing: string[]) => ({ schema: "pai-cad-checks-1", variant: "lightweight", cadquery: "2.8.0", ocp: "7.9.3.1.1", units: "mm", mass: 31.8, volume: 11780,
  boundingBox: [60, 30, 48.5], checks: ids.map(id => ({ id, passed: !failing.includes(id) })), scope: "parametric-part-geometry", physicalValidation: false });
function cadRecord(projectId: string, failing = ["min-wall"]): CadReview {
  return { id: randomUUID(), projectId, projectRevision: 1, request: { requestId: randomUUID(), projectRevision: 1, variant: "lightweight", requirements: DEFAULT_CAD_REQUIREMENTS },
    requirementDigest: "x", state: "completed", createdAt: new Date().toISOString(), verdict: "rejected",
    baseline: { ...checks([]), variant: "reference" } as CadReview["baseline"], candidate: checks(failing) as CadReview["candidate"],
    receipts: [], sourceDigests: {}, files: {}, scope: "parametric-part-geometry", physicalValidation: false };
}

test("CAD intent becomes a typed CadQuery plan with requirement direction", () => {
  const project = { ...task, id: randomUUID(), revision: 1, createdAt: "" } as Project;
  const plan = planFromMessage("评估 NEMA 17 电机支架轻量化方案，壁厚不低于 3 mm，质量不超过 60 g", { project, modelConfigured: false });
  const cad = plan.plans.find(p => p.tool === "cad-review")!;
  assert.equal(cad.payload.variant, "lightweight");
  assert.deepEqual(cad.payload.requirements, { ...DEFAULT_CAD_REQUIREMENTS, maxMassG: 60 });
  assert.equal(plan.plans.some(p => p.tool === "scene-review"), false, "CAD wording does not trigger the Blender lane");
  CadRequest.parse({ ...cad.payload, requestId: randomUUID() });
  const lastCad = cadRecord(project.id);
  const relaxed = planFromMessage("支架壁厚放宽到 2 mm，质量不超过 100 g", { project, lastCad, modelConfigured: false }).plans.find(p => p.tool === "cad-review")!;
  assert.equal(relaxed.changes.find(c => c.field === "minWallMm")!.direction, "relaxed");
  assert.equal(relaxed.changes.find(c => c.field === "maxMassG")!.direction, "relaxed");
  assert.ok(relaxed.warnings.some(w => w.includes("放宽")));
});

test("CAD feedback binds only a check that lost its baseline pass; lifecycle shows the case", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-cad-"));
  const store = new Store(join(dir, "s.sqlite"));
  try {
    const wb = new Workbench(store, {} as Adapters, dir), project = wb.createProject(task);
    const run = cadRecord(project.id); store.insert("cad-review", run);
    const base = { runId: run.id, evidenceKind: "cad-part", kind: "design-check", seed: null, expected: "4 mm plates", observed: "2.5 mm plates", actorKind: "maintainer" };
    const f = wb.createFeedback({ ...base, checkId: "min-wall" });
    assert.equal(f.status, "received");
    assert.throws(() => wb.createFeedback({ ...base, checkId: "mass" }), /baseline pass/);
    assert.throws(() => wb.createFeedback({ ...base, checkId: "camera-visibility" }), /does not belong/);
    assert.throws(() => wb.createFeedback({ ...base, checkId: "ev-service" }), /does not belong/);
    assert.throws(() => wb.createFeedback({ ...base, kind: "regression", seed: 1, checkId: undefined }), /baseline success/);
    const lifecycle = computeLifecycle({ project, reviews: [], scenes: [], cads: [run], factoryCriteria: [], factoryReviews: [], feedback: [f], campaigns: [], events: [], plans: [], proposals: [] });
    assert.deepEqual(lifecycle.failingCases.map(c => [c.kind, c.checkId, c.feedbackId]), [["cad-part", "min-wall", f.id]]);
    assert.match(lifecycle.failingCases[0].label, /最小壁厚/);
    assert.equal(lifecycle.next.stage, "feedback");
    assert.match(wb.createCampaign({ runId: run.id, evidenceKind: "cad-part", channel: "github" }).text, /No FEA, tolerance stack-up/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("CAD routes fail closed without a configured CadQuery and reject unknown files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-cad-http-"));
  const config = { ...configuration(), state: dir, cadquery: undefined };
  const { app, workbench, store } = await createApp(config, {} as Adapters);
  try {
    const h = { host: `127.0.0.1:${config.port}` };
    const p = workbench.createProject(task);
    const r = await app.inject({ method: "POST", url: `/api/projects/${p.id}/cad`, headers: h,
      payload: { requestId: randomUUID(), projectRevision: 1, variant: "reference", requirements: DEFAULT_CAD_REQUIREMENTS } });
    assert.equal(r.statusCode, 503); assert.equal(r.json().error, "CAD_NOT_CONFIGURED");
    const bad = await app.inject({ method: "POST", url: `/api/projects/${p.id}/cad`, headers: h,
      payload: { requestId: randomUUID(), projectRevision: 1, variant: "reference", requirements: DEFAULT_CAD_REQUIREMENTS, script: "import os" } });
    assert.equal(bad.statusCode, 400);
    const run = cadRecord(p.id); store.insert("cad-review", run);
    assert.equal((await app.inject({ url: `/api/cad/${run.id}/files/candidate/..%2Fsecret`, headers: h })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/cad/${run.id}/stages/candidate/1`, headers: h })).statusCode, 404);
    const state = (await app.inject({ url: "/api/state", headers: h })).json();
    assert.equal(state.capabilities.cad, false); assert.equal(state.cads.length, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("CAM runs where it is configured: the PAISolver job when the hosted Batch job exists, else the local FreeCAD", async () => {
  const { camRunner, camConfigured } = await import("../src/cad.js");
  const base = { cadquery: "/cq", repository: "/r" } as never as Parameters<typeof camRunner>[0];
  assert.equal(camRunner(base), undefined); assert.equal(camConfigured(base), false);
  assert.equal(camRunner({ ...base, camPython: "/fc" }), "local");
  const batch = { queue: "q", jobDefinition: "fea", camJobDefinition: "cam", bucket: "b", region: "r" };
  assert.equal(camRunner({ ...base, camPython: "/fc", physicsPython: "/py", solverBatch: batch }), "batch");
  assert.equal(camRunner({ ...base, physicsPython: "/py", solverBatch: { ...batch, camJobDefinition: undefined } }), undefined);
  assert.equal(camConfigured({ ...base, cadquery: undefined, camPython: "/fc" }), false, "the verifier needs the CadQuery venv");
});
