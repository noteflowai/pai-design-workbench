import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeStress, type Feedback, type Project, type Review } from "../src/contracts.js";
import { computeLifecycle, type LifecycleSnapshot } from "../src/lifecycle.js";
import type { Release } from "../src/release.js";
import { DEFAULT_FACTORY_CRITERIA, freezeFactoryCriteria, reviewFactory, REVIEWED_SAMPLE } from "../src/factory.js";


import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";

const stress = NativeStress.parse(JSON.parse(await readFile(new URL("./fixtures/stress-result.json", import.meta.url), "utf8")));
const project: Project = { id: randomUUID(), revision: 1, createdAt: "2026-09-30T00:00:00.000Z", title: "Lifecycle",
  intendedDecision: "Follow the full lifecycle", requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
const empty = (): LifecycleSnapshot => ({ project, reviews: [], scenes: [], factoryCriteria: [], factoryReviews: [], feedback: [], campaigns: [], events: [], plans: [], proposals: [] });
const review = (extra: Partial<Review> = {}) => ({ id: randomUUID(), projectId: project.id, state: "completed", candidate: "camera", stress,
  decision: { verdict: "rejected" }, createdAt: "2026-09-30T01:00:00.000Z", ...extra }) as unknown as Review;
const status = (l: ReturnType<typeof computeLifecycle>, id: string) => l.stages.find(s => s.id === id)!.status;

test("lifecycle guides from first validation through failure, feedback, closure and handoff", () => {
  let s = empty();
  let l = computeLifecycle(s);
  assert.equal(l.next.stage, "design"); assert.equal(status(l, "requirements"), "done"); assert.equal(status(l, "validate"), "pending");

  const run = review(); s = { ...s, reviews: [run] };
  l = computeLifecycle(s);
  assert.equal(status(l, "validate"), "done"); assert.equal(status(l, "evidence"), "attention");
  assert.deepEqual(l.failingCases.map(c => c.seed), [9]);
  assert.equal(l.next.stage, "evidence"); assert.equal(l.next.ref?.id, run.id);

  const feedback = { id: randomUUID(), projectId: project.id, runId: run.id, seed: 9, evidenceKind: "robot-review", status: "received", kind: "regression",
    expected: "keep seed 9", observed: "camera loses seed 9", actorKind: "maintainer", revision: 1,
    history: [{ status: "received", reason: "recorded", at: "2026-09-30T02:00:00.000Z" }] } as Feedback;
  s = { ...s, feedback: [feedback] };
  l = computeLifecycle(s);
  assert.equal(l.failingCases[0].feedbackId, feedback.id); assert.equal(status(l, "evidence"), "done");
  assert.equal(status(l, "feedback"), "attention"); assert.equal(l.next.stage, "feedback"); assert.match(l.next.label, /记录复现/);

  s = { ...s, feedback: [{ ...feedback, status: "closed" }] };
  l = computeLifecycle(s);
  // Only a rejected run exists: release needs a passing check first.
  assert.equal(status(l, "feedback"), "done"); assert.equal(l.next.stage, "design"); assert.match(l.next.label, /通过的检查/);
  assert.equal(status(l, "deliver"), "pending"); assert.equal(l.maturity.state, "none");

  const fixed = review({ candidate: "reference", decision: { verdict: "accepted-in-recorded-panel" }, feedbackId: feedback.id, createdAt: "2026-09-30T02:30:00.000Z" } as Partial<Review>);
  s = { ...s, reviews: [run, fixed] };
  l = computeLifecycle(s);
  assert.equal(l.next.stage, "deliver"); assert.match(l.next.label, /创建发布候选/);

  const release = { id: randomUUID(), projectId: project.id, revision: 1, number: "R1", title: "Rollback to reference", notes: "", evidenceKind: "robot-review", runId: fixed.id,
    projectRevision: 1, requirementDigest: "x", maturity: "in-review", admission: [], scope: "", createdAt: "2026-09-30T03:00:00.000Z",
    history: [{ maturity: "in-review", reason: "created", at: "2026-09-30T03:00:00.000Z", actor: "local-maintainer" }], physicalValidation: false, publicationApproved: false } as Release;
  l = computeLifecycle({ ...s, releases: [release] });
  assert.equal(status(l, "deliver"), "attention"); assert.match(l.next.label, /审批发布候选 R1/); assert.equal(l.maturity.state, "in-review");

  s = { ...s, releases: [{ ...release, maturity: "released" }] };
  l = computeLifecycle(s);
  assert.equal(status(l, "deliver"), "done"); assert.equal(l.maturity.number, "R1"); assert.match(l.next.label, /草稿/);
  s = { ...s, campaigns: [{ id: randomUUID(), projectId: project.id, runId: run.id, evidenceKind: "robot-review", channel: "direct-pilot", state: "draft", text: "", createdAt: "2026-09-30T04:00:00.000Z" }] };
  l = computeLifecycle(s);
  assert.match(l.next.label, /试用观察/);
  assert.equal(l.activity[0].stage, "deliver"); assert.equal(l.activity.at(-1)!.label, "创建任务并冻结需求");
});

test("running work takes priority; rechecks and repeated runs do not inflate failure cases", () => {
  const first = review(), again = review({ createdAt: "2026-09-30T05:00:00.000Z" }), recheck = review({ feedbackId: randomUUID() });
  let l = computeLifecycle({ ...empty(), reviews: [first, again, recheck] });
  assert.equal(l.failingCases.length, 1); assert.equal(l.failingCases[0].runId, again.id);
  l = computeLifecycle({ ...empty(), reviews: [first, review({ state: "running", decision: undefined })] });
  assert.equal(l.stages.find(s => s.id === "validate")!.status, "active"); assert.equal(l.next.stage, "validate");
  l = computeLifecycle({ ...empty(), reviews: [review({ state: "interrupted", decision: undefined })] });
  assert.equal(l.stages.find(s => s.id === "validate")!.status, "attention");
});

test("factory failing seeds become lifecycle cases; API exposes lifecycles per project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-life-"));
  const config = { ...configuration(), state: dir };
  const { app, store, workbench } = await createApp(config, {} as Adapters);
  try {
    const p = workbench.createProject({ title: project.title, intendedDecision: project.intendedDecision, requirements: project.requirements });
    const criteria = freezeFactoryCriteria(store, p, { requestId: randomUUID(), projectRevision: 1, criteria: DEFAULT_FACTORY_CRITERIA, rationale: "Frozen before import" });
    await reviewFactory(store, config.repository, p, { requestId: randomUUID(), projectRevision: 1, criteriaId: criteria.id, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id } });
    const h = { host: `127.0.0.1:${config.port}` };
    const l = (await app.inject({ url: `/api/projects/${p.id}/lifecycle`, headers: h })).json();
    assert.deepEqual(l.failingCases.map((c: { seed: number; checkId: string }) => `${c.checkId}:${c.seed}`), ["output-per-seed:3", "output-per-seed:11", "ev-service:10"]);
    assert.equal(l.next.stage, "evidence");
    const state = (await app.inject({ url: "/api/state", headers: h })).json();
    assert.equal(state.lifecycles[p.id].requirementDigest, l.requirementDigest);
    assert.equal((await app.inject({ url: `/api/projects/${randomUUID()}/lifecycle`, headers: h })).statusCode, 404);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("generated CAD parts are distinct candidates: a passing code revision never hides another revision's failure", () => {
  const checks = (wall: boolean) => ({ checks: ["solid-valid", "min-wall"].map(id => ({ id, passed: id === "min-wall" ? wall : true })) });
  const requirements = { maxMassG: 80, minWallMm: 3, edgeDistanceFactor: 1.5, requireNoInterference: true, maxEnvelopeMm: [80, 40, 60] };
  const part = (code: string, wall: boolean, at: string) => ({ id: randomUUID(), projectId: project.id, projectRevision: 1, state: "completed", createdAt: at,
    verdict: wall ? "accepted-cad-part" : "rejected", request: { variant: "generated", requirements, source: { language: "cadquery-2.8", code } },
    sandbox: { codeSha256: code.padEnd(64, "0"), isolation: [], status: "ok" }, baseline: checks(true), candidate: checks(wall) });
  const thin = part("a1", false, "2026-10-01T01:00:00.000Z"), revised = part("b2", true, "2026-10-01T02:00:00.000Z");
  const l = computeLifecycle({ ...empty(), cads: [thin, revised] } as unknown as LifecycleSnapshot);
  assert.deepEqual(l.failingCases.map(c => [c.runId, c.checkId]), [[thin.id, "min-wall"]]);
  assert.match(l.failingCases[0].label, /生成代码（代码 a1000000）失败/);
  // Same code and requirements is the same candidate: as for presets, its latest run stands.
  const same = part("a1", true, "2026-10-01T03:00:00.000Z");
  assert.equal(computeLifecycle({ ...empty(), cads: [thin, same] } as unknown as LifecycleSnapshot).failingCases.length, 0);
});
