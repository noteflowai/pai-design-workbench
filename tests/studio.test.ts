import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFromMessage, type AssistantPlan } from "../src/assistant.js";
import { LiveBus } from "../src/live.js";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { sha256 } from "../src/domain.js";
import type { Adapters } from "../src/adapters.js";
import type { PlantScene, SceneReview, WorkcellScene } from "../src/scenes.js";
import type { Project } from "../src/contracts.js";

const task = { title: "Studio", intendedDecision: "Plan native checks from conversation",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
const project = { ...task, id: randomUUID(), revision: 2, createdAt: "" } as Project;
const localHeaders = (port: number) => ({ host: `127.0.0.1:${port}`, "content-type": "application/json" });

test("messages become schema-valid typed plans without authority or model use", () => {
  const plan = planFromMessage("生成带遮挡的 Blender 工作单元，占地不超过 10 平方米，包络半径 1.2 m", { project, modelConfigured: false });
  const scene = plan.plans.find(p => p.tool === "scene-review")!;
  assert.deepEqual(scene.payload, { projectRevision: 2, variant: "occluded", requirements: { maxFootprintArea: 10, targetEnvelopeRadius: 1.2, requireTargetVisible: true } });
  assert.equal(scene.requiresConfirmation, true);
  assert.equal(plan.authority, "none"); assert.equal(plan.model.used, false);
  assert.ok(!("requestId" in scene.payload));
});

test("relaxing a frozen constraint is shown as a relaxation with a warning", () => {
  const lastScene = { request: { variant: "occluded", requirements: { maxFootprintArea: 12, targetEnvelopeRadius: 1.4, requireTargetVisible: true } } } as WorkcellScene;
  const plan = planFromMessage("把占地放宽到 20 m2，并且不要求可见，移除遮挡", { project, lastScene, modelConfigured: false });
  const scene = plan.plans.find(p => p.tool === "scene-review")!;
  assert.equal(scene.changes.find(c => c.field === "maxFootprintArea")!.direction, "relaxed");
  assert.equal(scene.changes.find(c => c.field === "requireTargetVisible")!.direction, "relaxed");
  assert.equal(scene.changes.find(c => c.field === "variant")!.direction, "changed");
  assert.ok(scene.warnings.some(w => w.includes("放宽")));
});

test("production-line intent becomes a validated plant-layout plan and does not trigger the factory twin", () => {
  const plan = planFromMessage("设计 6 工位 CNC 产线：节距 4.5 m，围栏 4.2 m，通道 2.4 m，相机 2.8 m，3 台 AGV，厂房 ≤ 650 m²", { project, modelConfigured: false });
  assert.deepEqual(plan.plans.map(p => p.tool), ["plant-layout"]);
  const step = plan.plans[0];
  assert.equal(step.route, `/projects/${project.id}/scenes`);
  assert.deepEqual(step.payload.layout, { stations: 6, stationPitch: 4.5, aisleWidth: 2.4, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 });
  assert.equal((step.payload.requirements as { maxFootprintArea: number }).maxFootprintArea, 650);
  assert.equal(step.payload.variant, "plant");
  assert.ok(step.changes.every(c => c.direction === "new"));
});

test("plant plan records layout edits and flags a relaxed footprint", () => {
  const lastPlant = { request: { variant: "plant", layout: { stations: 6, stationPitch: 4.5, aisleWidth: 2.4, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 },
    requirements: { maxFootprintArea: 650, minAisleWidth: 2.4, minGuardClearance: 0.5, requireCameraCoverage: true, maxEgressTravel: 25 } } } as PlantScene;
  const plan = planFromMessage("产线通道改为 2.8 m，厂房放宽到 700 m2", { project, lastPlant, modelConfigured: false });
  const step = plan.plans.find(p => p.tool === "plant-layout")!;
  assert.equal(step.changes.find(c => c.field === "layout.aisleWidth")!.direction, "changed");
  assert.equal(step.changes.find(c => c.field === "layout.stations")!.direction, "same");
  assert.equal(step.changes.find(c => c.field === "maxFootprintArea")!.direction, "relaxed");
  assert.ok(step.warnings.some(w => w.includes("放宽")));
});

test("factory intent freezes criteria first and chains the review on that record", () => {
  const plan = planFromMessage("评审工厂维护与能源方案，EV 充电不低于 70%，产出损失不超过 3 件，车间不超过 25 °C", { project, modelConfigured: false });
  const [criteria, review] = plan.plans;
  assert.equal(criteria.tool, "factory-criteria"); assert.equal(review.tool, "factory-review");
  assert.equal(review.dependsOn, criteria.id);
  assert.equal(review.payload.criteriaId, `{${criteria.id}}`);
  assert.deepEqual((criteria.payload.criteria as Record<string, unknown>), { maxOutputLossPerSeed: 3, maxClosedIntervalsOverLimit: 0,
    maxHallC: 25, minEvServiceRatio: 0.7, maxClosedFailures: 0, requireNetOutputGain: true });
});

test("unknown intent and unconfigured models produce explanations, never tool calls", () => {
  const plan = planFromMessage("请用模型提案帮我写诗", { project, modelConfigured: false });
  assert.equal(plan.unmatched, true);
  assert.equal(plan.plans.filter(p => p.tool === "model-proposal").length, 0);
  assert.ok(plan.interpretation.some(i => i.includes("受控模型未配置")));
});

test("live bus replays, bounds render events and stops after done", () => {
  const bus = new LiveBus(3, 10);
  const key = randomUUID();
  for (let i = 0; i < 5; i++) bus.publish(key, { kind: "render", which: "candidate", sample: i, samples: 5 });
  bus.publish(key, { kind: "done", state: "completed" });
  bus.publish(key, { kind: "step", id: "late", label: "late", status: "done" });
  const { replay, done, close } = bus.subscribe(key, () => {});
  close();
  assert.equal(done, true);
  assert.deepEqual(replay.map(e => e.kind), ["render", "done"]);
  assert.equal((replay[0] as { sample: number }).sample, 4);
  for (let i = 0; i < 5; i++) bus.publish(randomUUID(), { kind: "done", state: "x" });
  assert.ok(bus.size() <= 3);
  const open = [0, 1, 2].map(() => bus.subscribe(randomUUID(), () => {}));
  assert.throws(() => bus.subscribe(randomUUID(), () => {}), /Too many open live streams/);
  open.forEach(o => o.close());
});

test("HTTP: plan, confirmation audit, SSE replay and digest-checked stage geometry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-studio-"));
  const config = { ...configuration(), state: dir };
  const { app, store, workbench } = await createApp(config, {} as Adapters);
  try {
    const h = localHeaders(config.port);
    const p = workbench.createProject(task);
    const planned = await app.inject({ method: "POST", url: "/api/assistant/plans", headers: h,
      payload: { requestId: randomUUID(), projectId: p.id, message: "工厂能源评审，EV 充电不低于 80%" } });
    assert.equal(planned.statusCode, 200);
    const plan = planned.json() as AssistantPlan;
    const criteriaStep = plan.plans[0];
    const criteriaRequestId = randomUUID();
    const frozen = await app.inject({ method: "POST", url: `/api/projects/${p.id}/factory-criteria`, headers: h,
      payload: { ...criteriaStep.payload, requestId: criteriaRequestId } });
    assert.equal(frozen.statusCode, 200);
    const reviewRequestId = randomUUID();
    const reviewed = await app.inject({ method: "POST", url: `/api/projects/${p.id}/factory-reviews`, headers: h,
      payload: { ...plan.plans[1].payload, criteriaId: frozen.json().id, requestId: reviewRequestId } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const confirmed = await app.inject({ method: "POST", url: `/api/assistant/plans/${plan.id}/confirmations`, headers: h,
      payload: { planId: criteriaStep.id, recordKind: "factory-criteria", recordId: frozen.json().id } });
    assert.equal(confirmed.json().confirmations[0].match, "as-proposed");
    const mismatch = await app.inject({ method: "POST", url: `/api/assistant/plans/${plan.id}/confirmations`, headers: h,
      payload: { planId: criteriaStep.id, recordKind: "review", recordId: frozen.json().id } });
    assert.equal(mismatch.statusCode, 422);

    const stream = await app.inject({ url: `/api/live/${reviewRequestId}`, headers: h });
    assert.equal(stream.statusCode, 200);
    assert.match(String(stream.headers["content-type"]), /text\/event-stream/);
    assert.match(String(stream.headers["content-security-policy"]), /default-src 'self'/);
    assert.match(stream.body, /event: step/); assert.match(stream.body, /event: done/);
    assert.match(stream.body, /"verdict":"rejected"/);

    const sceneId = randomUUID(), file = "stages/01-footprint.glb", bytes = Buffer.from("glTF-stage-fixture");
    await mkdir(join(dir, "scenes", sceneId, "candidate", "stages"), { recursive: true });
    await writeFile(join(dir, "scenes", sceneId, "candidate", file), bytes);
    store.insert("scene-review", { id: sceneId, projectId: p.id, state: "running",
      stages: { candidate: [{ index: 1, id: "footprint", label: "x", file, sha256: sha256(bytes), objects: [] }] } } as unknown as SceneReview);
    const stage = await app.inject({ url: `/api/scenes/${sceneId}/stages/candidate/1`, headers: h });
    assert.equal(stage.statusCode, 200); assert.equal(stage.headers["x-pai-evidence"], "presentation-stage");
    await writeFile(join(dir, "scenes", sceneId, "candidate", file), "tampered");
    assert.equal((await app.inject({ url: `/api/scenes/${sceneId}/stages/candidate/1`, headers: h })).statusCode, 422);
    assert.equal((await app.inject({ url: `/api/scenes/${sceneId}/stages/candidate/2`, headers: h })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/live/not-a-uuid`, headers: h })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/live/${randomUUID()}`, headers: { host: "evil.example" } })).statusCode, 403);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test("open live streams end on shutdown instead of holding the server open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-sse-"));
  const config = { ...configuration(), state: dir };
  const { app } = await createApp(config, {} as Adapters);
  try {
    await app.listen({ port: 0, host: "127.0.0.1" });
    config.port = (app.server.address() as { port: number }).port; // Host guard reads the configured port per request.
    const response = await fetch(`http://127.0.0.1:${config.port}/api/live/${randomUUID()}`);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /presentation-only/);
    const closed = app.close();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; }
    await closed;
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
