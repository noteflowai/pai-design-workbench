import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Workbench } from "../src/service.js";
import { consistency, DEFAULT_FACTORY_CRITERIA, evaluateFactory, freezeFactoryCriteria, reviewFactory, REVIEWED_SAMPLE,
  type FactoryCriteriaValues, type FactoryReview } from "../src/factory.js";
import { sha256 } from "../src/domain.js";
import type { Adapters } from "../src/adapters.js";

const repository = new URL("..", import.meta.url).pathname;
const directory = join(repository, REVIEWED_SAMPLE.directory);
const seedsText = await readFile(join(directory, "seeds.json"), "utf8");
const manifestText = await readFile(join(directory, "manifest.json"), "utf8");
const task = { title: "Factory maintenance / energy review", intendedDecision: "Accept only plans that preserve output, EV service and comfort",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pai-factory-"));
  const store = new Store(join(dir, "state.sqlite"));
  const wb = new Workbench(store, {} as Adapters, dir), project = wb.createProject(task);
  const freeze = (criteria: FactoryCriteriaValues = DEFAULT_FACTORY_CRITERIA) => freezeFactoryCriteria(store, project,
    { requestId: randomUUID(), projectRevision: 1, criteria, rationale: "Frozen before any Factory Twin evidence is imported" });
  const review = (criteriaId: string, extra: Record<string, unknown> = {}) => reviewFactory(store, repository, wb.project(project.id),
    { requestId: randomUUID(), projectRevision: 1, criteriaId, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id }, ...extra });
  return { dir, store, wb, project, freeze, review, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("bundled upstream extract is byte-identical to the reviewed commit", () => {
  assert.equal(sha256(seedsText), REVIEWED_SAMPLE.seedsSha256);
  assert.equal(sha256(manifestText), REVIEWED_SAMPLE.manifestSha256);
  const checked = consistency(seedsText, manifestText);
  assert.equal(checked.seeds.seeds.length, 12);
  assert.deepEqual(checked.checks.map(c => c.id), ["manifest-digest", "unique-seeds", "shadow-observes-only", "summary-recomputed"]);
});

test("real v0.18.0 panel is rejected under default criteria and every degraded seed is retained", async () => {
  const s = await setup();
  try {
    const run = await s.review(s.freeze().id);
    assert.equal(run.verdict, "rejected");
    assert.equal(run.seeds.length, 12);
    assert.equal(run.aggregate.netGoodUnitsGain, 133);
    assert.deepEqual(run.aggregate.failingSeeds["output-per-seed"], [3, 11]);
    assert.deepEqual(run.aggregate.failingSeeds["ev-service"], [10]);
    assert.deepEqual(run.aggregate.failingSeeds["demand-intervals"], []);
    assert.equal(run.checks.find(c => c.id === "net-output-gain")!.passed, true);
    assert.equal(run.provenance, "illustrative-simulation");
    assert.equal(run.physicalValidation, false); assert.equal(run.realFactoryCalibrated, false); assert.equal(run.productionToolUpgraded, false);
    assert.equal(run.source.sourceCommit, REVIEWED_SAMPLE.sourceCommit);
  } finally { await s.cleanup(); }
});

test("a deliberately relaxed frozen criteria version accepts without rewriting the stricter result", async () => {
  const s = await setup();
  try {
    const strict = await s.review(s.freeze().id);
    const relaxed = await s.review(s.freeze({ ...DEFAULT_FACTORY_CRITERIA, maxOutputLossPerSeed: 3, minEvServiceRatio: 0.7 }).id);
    assert.equal(relaxed.verdict, "accepted-illustrative");
    assert.equal(s.store.get<FactoryReview>("factory-review", strict.id)!.verdict, "rejected");
    assert.notEqual(strict.criteriaDigest, relaxed.criteriaDigest);
  } finally { await s.cleanup(); }
});

test("energy intensity never offsets a net output loss", () => {
  const checked = consistency(seedsText, manifestText);
  const worse = structuredClone(checked.seeds);
  for (const seed of worse.seeds) seed.closed.good_units = seed.shadow.good_units - 1;
  const result = evaluateFactory(worse, { ...DEFAULT_FACTORY_CRITERIA, maxOutputLossPerSeed: 5, minEvServiceRatio: 0 });
  assert.ok(result.aggregate.meanImportIntensityChange !== 0);
  assert.equal(result.checks.find(c => c.id === "net-output-gain")!.passed, false);
  assert.equal(result.verdict, "rejected");
});

test("modified bytes, a forged summary, duplicate seeds or shadow actuation fail closed", () => {
  const edited = seedsText.replace('"good_units": 199', '"good_units": 219');
  assert.throws(() => consistency(edited, manifestText), /digest and size/);
  const forge = (mutate: (d: any) => void) => {
    const d = JSON.parse(seedsText); mutate(d);
    const text = JSON.stringify(d, null, 1);
    const manifest = JSON.parse(manifestText);
    manifest.files["seeds.json"] = { sha256: sha256(text), bytes: Buffer.byteLength(text) };
    return () => consistency(text, JSON.stringify(manifest));
  };
  assert.throws(forge(d => { d.summary.good_units_gain.pairs_worse = 0; }), /summary disagrees/);
  assert.throws(forge(d => { d.seeds[1].seed = d.seeds[0].seed; }), /Duplicated/);
  assert.throws(forge(d => { d.seeds[0].shadow.commands_actuated = 2; }), /Shadow mode/);
  assert.throws(() => consistency("{}", manifestText), /factory-twin-1 format/);
});

test("criteria must be frozen for this project revision before evidence is imported", async () => {
  const s = await setup();
  try {
    await assert.rejects(s.review(randomUUID()), /Freeze factory acceptance criteria/);
    const criteria = s.freeze();
    s.wb.updateProject(s.project.id, 1, task);
    await assert.rejects(reviewFactory(s.store, repository, s.wb.project(s.project.id), { requestId: randomUUID(), projectRevision: 2,
      criteriaId: criteria.id, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id } }), /Freeze factory acceptance criteria/);
  } finally { await s.cleanup(); }
});

test("review identity is idempotent and cannot change meaning", async () => {
  const s = await setup();
  try {
    const criteria = s.freeze(), requestId = randomUUID();
    const input = { requestId, projectRevision: 1, criteriaId: criteria.id, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id } };
    const first = await reviewFactory(s.store, repository, s.project, input);
    assert.equal((await reviewFactory(s.store, repository, s.project, input)).id, first.id);
    await assert.rejects(reviewFactory(s.store, repository, s.project, { ...input, criteriaId: s.freeze().id }), /cannot be reused/);
    const upload = await reviewFactory(s.store, repository, s.project, { requestId: randomUUID(), projectRevision: 1, criteriaId: criteria.id,
      source: { kind: "upload", seedsText, manifestText, sourceCommit: REVIEWED_SAMPLE.sourceCommit } });
    assert.equal(upload.source.reviewedByWorkbench, false);
    assert.equal(upload.verdict, first.verdict);
  } finally { await s.cleanup(); }
});

test("factory feedback binds a failing seed and closes only through a documented no-change recheck", async () => {
  const s = await setup();
  try {
    const criteria = s.freeze(), run = await s.review(criteria.id);
    assert.throws(() => s.wb.createFeedback({ runId: run.id, evidenceKind: "factory-twin", kind: "design-check", checkId: "ev-service", seed: 1,
      expected: "EV service preserved", observed: "Seed 1 passes; binding it must fail", actorKind: "maintainer" }), /must bind a seed that fails/);
    assert.throws(() => s.wb.createFeedback({ runId: run.id, evidenceKind: "factory-twin", kind: "regression", seed: 10,
      expected: "x", observed: "y", actorKind: "maintainer" }), /not a recorded robot regression/);
    let f = s.wb.createFeedback({ runId: run.id, evidenceKind: "factory-twin", kind: "design-check", checkId: "ev-service", seed: 10,
      expected: "Closed EV service at least 80% of the schedule", observed: "Seed 10 delivered 74%", actorKind: "maintainer" });
    for (const status of ["reproducible", "assigned", "fix-proposed"] as const) {
      f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status, reason: "Reproduced from the retained seed result" });
    }
    const unfixed = await s.review(criteria.id, { feedbackId: f.id });
    assert.throws(() => s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "rechecked", reason: "Same upstream data", recheckRunId: unfixed.id }), /still fails the frozen factory check/);
    await assert.rejects(s.review(s.freeze().id, { feedbackId: f.id }), /originally frozen criteria/);
    assert.equal(s.wb.feedback(f.id).status, "fix-proposed");
  } finally { await s.cleanup(); }
});

test("documented no-change recheck keeps the failure visible and closes the disposition", async () => {
  const s = await setup();
  try {
    const criteria = s.freeze(), run = await s.review(criteria.id);
    let f = s.wb.createFeedback({ runId: run.id, evidenceKind: "factory-twin", kind: "design-check", checkId: "output-per-seed", seed: 3,
      expected: "No per-seed output loss", observed: "Seed 3 lost 3 good units", actorKind: "maintainer" });
    for (const status of ["reproducible", "assigned", "no-change-with-reason"] as const) {
      f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status, reason: "Retain as a known limitation until upstream reruns the twin" });
    }
    const recheck = await s.review(criteria.id, { feedbackId: f.id });
    assert.equal(recheck.verdict, "rejected");
    f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "rechecked", reason: "Re-evaluated under the same frozen criteria", recheckRunId: recheck.id });
    f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "closed", reason: "Disposition documented; failure remains in the record" });
    assert.equal(f.status, "closed");
    assert.deepEqual(recheck.aggregate.failingSeeds["output-per-seed"], [3, 11]);
    const campaign = s.wb.createCampaign({ runId: run.id, evidenceKind: "factory-twin", channel: "direct-pilot" });
    assert.match(campaign.text, /illustrative-simulation/);
    assert.match(campaign.text, /output-per-seed: 3, 11/);
    assert.match(campaign.text, /do not grant acceptance/);
  } finally { await s.cleanup(); }
});
