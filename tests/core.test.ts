import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeStress, type DiffResult, type Review } from "../src/contracts.js";
import { canonical, sha256, validatePanel } from "../src/domain.js";
import { makeBundle, verifyBundle } from "../src/bundle.js";
import { Store } from "../src/store.js";
import { Workbench } from "../src/service.js";
import { type Adapters } from "../src/adapters.js";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { propose, type Proposal } from "../src/proposals.js";

const raw = await readFile(new URL("./fixtures/stress-result.json", import.meta.url), "utf8");
const stress = NativeStress.parse(JSON.parse(raw));
const radarRaw = JSON.stringify({ date: "2026-09-28", picked: [] });
const task = { title: "Paired robot review", intendedDecision: "Preserve the recorded baseline successes",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
function fixtures() {
  let calls = 0;
  const adapters: Adapters = {
    radar: async () => ({ value: JSON.parse(radarRaw), raw: radarRaw, digest: sha256(radarRaw) }),
    sourceDigests: async () => ({ fixture: sha256(raw) }),
    stress: async () => { calls++; return { value: structuredClone(stress), raw, receipt: { adapter: "robot-reel-native", command: ["fixture"], startedAt: "", finishedAt: "", exitCode: 0, stdoutSha256: sha256(raw), sourceDigests: {} } }; },
    diff: async dir => {
      const current = await readFile(join(dir, "current.xml"), "utf8");
      const reference = current.includes('value="reference"');
      const value: DiffResult = { schema_version: "evalarc.results-diff.v1", gate_passed: reference,
        blocking_changes: reference ? 0 : 1, changes: [], interpretation: "Fixture for domain failure tests only" };
      const text = JSON.stringify(value);
      return { value, raw: text, receipt: { adapter: "evalarc-native", command: ["fixture"], startedAt: "", finishedAt: "", exitCode: reference ? 0 : 1, stdoutSha256: sha256(text), sourceDigests: {} } };
    },
    controller: async () => ({ state: "fixture", mode: "read-only-accounting", publicationApproved: false }),
  };
  return { adapters, calls: () => calls };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pai-domain-"));
  const store = new Store(join(dir, "state.sqlite"));
  const fixture = fixtures(), wb = new Workbench(store, fixture.adapters, dir), project = wb.createProject(task);
  return { dir, store, wb, project, ...fixture, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}
test("paired evidence rejects duplicate seeds, inconsistent reference and forged p-values", () => {
  const duplicate = structuredClone(stress); const same = duplicate.pairs.filter(p => p.condition === "dim"); same[0].seed = same[1].seed;
  assert.throws(() => validatePanel(duplicate), /duplicated/);
  const p = structuredClone(stress); p.paired_exact_test.comparisons[0].holm_adjusted_p = 0.01;
  assert.throws(() => validatePanel(p), /statistics/);
  const ref = structuredClone(stress);
  const dim = ref.pairs.filter(p => p.condition === "dim");
  const a = dim.find(p => p.reference_success)!, b = dim.find(p => !p.reference_success)!;
  a.reference_success = false; b.reference_success = true;
  assert.throws(() => validatePanel(ref));
});
test("remote native work returns a durable polling identity and never relaunches duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-poll-"));
  const fixture = fixtures(), original = fixture.adapters.stress;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fixture.adapters.stress = async () => { await gate; return original(); };
  const { app, store, workbench } = await createApp({ ...configuration(), state: dir, publicOrigin: "https://pai.oneai.host" }, fixture.adapters);
  try {
    const project = workbench.createProject(task);
    const headers = { host: "pai.oneai.host", origin: "https://pai.oneai.host" };
    const payload = { requestId: randomUUID(), projectRevision: 1, candidate: "camera" };
    const url = `/api/projects/${project.id}/reviews`;
    const response = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(response.statusCode, 202);
    const id = response.json().id, location = response.headers.location as string;
    assert.equal(store.requestRun(payload.requestId), id);
    assert.equal((await app.inject({ url: location, headers })).statusCode, 202);
    const duplicate = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(duplicate.statusCode, 202); assert.equal(duplicate.json().id, id);
    const conflict = await app.inject({ method: "POST", url, headers, payload: { ...payload, candidate: "reference" } });
    assert.equal(conflict.statusCode, 409);
    release();
    // Closing waits for background native work to retain its final receipt.
    await app.close();
    const retained = new Store(join(dir, "workbench.sqlite"));
    try {
      assert.equal(retained.get<Review>("review", id)?.state, "completed");
      assert.equal(fixture.calls(), 1);
    } finally { retained.close(); }
  } finally { release(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test("concurrent duplicate identity runs once; changing identity meaning conflicts", async () => {
  const s = await setup();
  try {
    const request = { requestId: randomUUID(), projectRevision: 1, candidate: "camera" };
    const results = await Promise.all([s.wb.runReview(s.project.id, request), s.wb.runReview(s.project.id, request)]);
    assert.equal(results[0].id, results[1].id); assert.equal(s.calls(), 1);
    assert.equal(s.wb.review(results[0].id).decision?.verdict, "rejected");
    await assert.rejects(s.wb.runReview(s.project.id, { ...request, candidate: "reference" }), /identity/);
  } finally { await s.cleanup(); }
});
test("native false-green and source mutation fail closed", async () => {
  for (const kind of ["false-green", "source-change"]) {
    const s = await setup();
    try {
      if (kind === "false-green") {
        const original = s.adapters.diff;
        s.adapters.diff = async d => { const result = await original(d); result.value.gate_passed = true; result.value.blocking_changes = 0; return result; };
      } else {
        let n = 0; s.adapters.sourceDigests = async () => ({ fixture: sha256(String(n++)) });
      }
      const run = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera" });
      assert.equal(run.state, "failed"); assert.equal(run.decision, undefined);
      assert.match(run.error!, kind === "false-green" ? /DIFF_MISMATCH/ : /SOURCE_CHANGED/);
    } finally { await s.cleanup(); }
  }
});
test("restart retains interrupted identity without replay", async () => {
  const s = await setup();
  try {
    const request = { requestId: randomUUID(), projectRevision: 1, candidate: "camera" };
    const id = randomUUID(), digest = sha256(canonical({ projectId: s.project.id, request }));
    s.store.claim(request.requestId, digest, { id, state: "running" } as { id: string });
    s.store.interruptPending();
    const run = await s.wb.runReview(s.project.id, request);
    assert.equal(run.state, "interrupted"); assert.equal(s.calls(), 0);
  } finally { await s.cleanup(); }
});
test("feedback cannot close early, reuse original run or accept an unfixed seed", async () => {
  const s = await setup();
  try {
    const run = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera" });
    let feedback = s.wb.createFeedback({ runId: run.id, kind: "regression", seed: 9, expected: "Pass baseline seed", observed: "Camera fails", actorKind: "fixture" });
    const change = (status: string, recheckRunId?: string) => s.wb.transitionFeedback(feedback.id, { expectedRevision: feedback.revision, status, reason: "Retain evidence and roll back reference", ...(recheckRunId ? { recheckRunId } : {}) });
    assert.throws(() => change("closed"), /reproduction/);
    for (const status of ["reproducible", "assigned", "fix-proposed"]) feedback = change(status);
    assert.throws(() => change("rechecked", run.id), /Recheck/);
    const failed = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera", feedbackId: feedback.id });
    assert.throws(() => change("rechecked", failed.id), /still fails/);
    const fixed = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "reference", feedbackId: feedback.id });
    feedback = change("rechecked", fixed.id); feedback = change("closed");
    assert.equal(feedback.status, "closed"); assert.equal(feedback.history.at(-2)?.recheckRunId, fixed.id);
    assert.throws(() => s.wb.updateProject(s.project.id, 2, task), /changed/);
  } finally { await s.cleanup(); }
});
test("handoff detects hash, mapping, requirement and coordinated false-green changes", async () => {
  const s = await setup();
  try {
    const run = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera" });
    const original = makeBundle(run);
    assert.equal(verifyBundle(original).valid, true);
    for (const mode of ["hash", "mapping", "requirement", "gate", "case"]) {
      const packet = structuredClone(original);
      if (mode === "hash") packet.files["case.md"].content += "modified";
      if (mode === "case") { packet.files["case.md"].content += "Claim: ready for deployment"; packet.files["case.md"].sha256 = sha256(packet.files["case.md"].content); }
      if (mode === "mapping") { packet.files["current.xml"].content = packet.files["baseline.xml"].content; packet.files["current.xml"].sha256 = sha256(packet.files["current.xml"].content); }
      if (mode === "requirement" || mode === "gate") {
        const record = JSON.parse(packet.files["review.json"].content) as Review;
        if (mode === "requirement") record.project.requirements.preserveBaselineSuccess = false;
        else {
          record.diff!.gate_passed = true; record.diff!.blocking_changes = 0;
          packet.files["evalarc.json"].content = JSON.stringify(record.diff);
          packet.files["evalarc.json"].sha256 = sha256(packet.files["evalarc.json"].content);
          record.receipts.find(r => r.adapter === "evalarc-native")!.stdoutSha256 = packet.files["evalarc.json"].sha256;
        }
        packet.files["review.json"].content = JSON.stringify(record);
        packet.files["review.json"].sha256 = sha256(packet.files["review.json"].content);
      }
      assert.throws(() => verifyBundle(packet), mode);
    }
  } finally { await s.cleanup(); }
});
test("maintainer and fixture actions never count as independent adoption", async () => {
  const s = await setup();
  try {
    const run = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera" });
    const campaign = s.wb.createCampaign({ runId: run.id, channel: "direct-pilot" });
    for (const actorKind of ["maintainer", "fixture"]) {
      const event = { eventId: randomUUID(), campaignId: campaign.id, participantId: actorKind, actorKind, kind: "completed" };
      s.wb.trackEvent(event); s.wb.trackEvent(event);
    }
    assert.equal(s.wb.metrics().independentParticipants, 0);
    assert.equal(s.wb.metrics().conversionRate, null);
    assert.equal(s.wb.metrics().maintainerEvents, 1);
  } finally { await s.cleanup(); }
});
test("changing requirements after recheck prevents closing stale feedback", async () => {
  const s = await setup();
  try {
    const camera = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera" });
    let f = s.wb.createFeedback({ runId: camera.id, kind: "regression", seed: 9, expected: "Pass", observed: "Fails", actorKind: "fixture" });
    for (const status of ["reproducible", "assigned", "fix-proposed"]) f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status, reason: "Rollback after recorded reproduction" });
    const fixed = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "reference", feedbackId: f.id });
    f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "rechecked", reason: "New native record bound to feedback", recheckRunId: fixed.id });
    s.wb.updateProject(s.project.id, 1, { ...task, requirements: { ...task.requirements, minSuccessRate: 0.7 } });
    assert.throws(() => s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "closed", reason: "Cannot close under obsolete requirements" }), /Requirements changed/);
  } finally { await s.cleanup(); }
});
test("documented no-change closes disposition without turning failed evidence green", async () => {
  const s = await setup();
  try {
    const camera = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera" });
    let f = s.wb.createFeedback({ runId: camera.id, kind: "regression", seed: 9, expected: "Keep baseline pass", observed: "Recorded loss", actorKind: "fixture" });
    for (const status of ["reproducible", "assigned", "no-change-with-reason"]) f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status, reason: "Retain rejected condition for further investigation; no deployment approval" });
    const retained = await s.wb.runReview(s.project.id, { requestId: randomUUID(), projectRevision: 1, candidate: "camera", feedbackId: f.id });
    f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "rechecked", reason: "Documented unchanged condition still rejected after check", recheckRunId: retained.id });
    f = s.wb.transitionFeedback(f.id, { expectedRevision: f.revision, status: "closed", reason: "Disposition documented; native failure and rejected decision remain unchanged" });
    assert.equal(f.status, "closed"); assert.equal(retained.decision?.verdict, "rejected"); assert.equal(retained.diff?.gate_passed, false);
  } finally { await s.cleanup(); }
});
test("HTTP rejects cross-origin writes, foreign host and arbitrary command fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-http-"));
  const { app } = await createApp({ ...configuration(), state: dir }, fixtures().adapters);
  try {
    const base = { method: "POST" as const, url: "/api/projects", payload: task };
    assert.equal((await app.inject({ ...base, headers: { host: "127.0.0.1:4317", origin: "https://foreign.example" } })).statusCode, 403);
    assert.equal((await app.inject({ ...base, headers: { host: "attacker.example" } })).statusCode, 403);
    assert.equal((await app.inject({ ...base, headers: { host: "127.0.0.1:4317" }, payload: { ...task, command: "shell" } })).statusCode, 400);
    assert.equal((await app.inject({ ...base, headers: { host: "127.0.0.1:4317" } })).statusCode, 200);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
test("second server cannot interrupt a live owner's persisted request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-owner-"));
  const config = { ...configuration(), state: dir };
  const first = await createApp(config, fixtures().adapters);
  try {
    first.store.insert("review", { id: randomUUID(), state: "running" } as { id: string });
    await assert.rejects(createApp(config, fixtures().adapters), /Another local server/);
    assert.equal(first.store.list<{ state: string }>("review")[0].state, "running");
  } finally { await first.app.close(); }
  const restarted = await createApp(config, fixtures().adapters);
  try { assert.equal(restarted.store.list<{ state: string }>("review")[0].state, "interrupted"); }
  finally { await restarted.app.close(); await rm(dir, { recursive: true, force: true }); }
});
test("unknown proposal effects cannot be bypassed with a fresh identity or provider", async () => {
  const s = await setup();
  try {
    const request = { requestId: randomUUID(), projectRevision: 1, profiles: ["kiro-primary" as const] };
    const saved: Proposal = { id: randomUUID(), projectId: s.project.id, state: "reconcile", createdAt: "",
      request, requirementDigest: sha256(canonical(s.project.requirements)), publicationApproved: false, decisionAuthority: false };
    s.store.insert("proposal", saved);
    assert.equal((await propose(s.store, configuration(), s.project, request)).id, saved.id);
    await assert.rejects(propose(s.store, configuration(), s.project, { ...request, requestId: randomUUID(), profiles: ["codex"] }), /cannot bypass/);
  } finally { await s.cleanup(); }
});

test("every hosted 202 status route the server emits is followed by the browser client", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../web/api.ts", import.meta.url), "utf8");
  const routes = [...server.matchAll(/executeNative\(reply, request\.body, "[^"]+", "([^"]+)"/g)].map(m => m[1]);
  assert.ok(routes.length >= 5, routes.join(","));
  const pattern = new RegExp(/new RegExp|(\/\^\\\/api\\\/\(.*?\)\\\/\[a-f0-9-\]\+\$\/)/.exec(client)![1].slice(1, -1));
  for (const route of new Set(routes)) assert.ok(pattern.test(`/api/${route}/0a1b2c3d-0000-4000-8000-000000000000`), `client must poll /api/${route}/:id`);
});
