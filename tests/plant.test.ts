import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PLANT_REQUIREMENTS, PLANT_REFERENCE, plantHall, SceneChecks, SceneRequest, sceneKey } from "../src/scenes.js";
import { failingCases, type LifecycleSnapshot } from "../src/lifecycle.js";
import type { SceneReview } from "../src/scenes.js";
import type { Project } from "../src/contracts.js";

const id = "00000000-0000-4000-8000-000000000001";
const layout = { stations: 6, stationPitch: 4.5, aisleWidth: 2.4, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 };

test("plant requests are a bounded, strict variant of the scene contract", () => {
  const ok = SceneRequest.parse({ requestId: id, projectRevision: 1, variant: "plant", layout, requirements: DEFAULT_PLANT_REQUIREMENTS });
  assert.equal(ok.variant, "plant");
  for (const bad of [{ ...layout, stations: 9 }, { ...layout, aisleWidth: 0.5 }, { ...layout, stations: 4.5 }, { ...layout, script: "import os" }]) {
    assert.equal(SceneRequest.safeParse({ requestId: id, projectRevision: 1, variant: "plant", layout: bad, requirements: DEFAULT_PLANT_REQUIREMENTS }).success, false);
  }
  // A workcell request cannot smuggle a layout, and a plant request needs one.
  assert.equal(SceneRequest.safeParse({ requestId: id, projectRevision: 1, variant: "clear", layout, requirements: { maxFootprintArea: 12, targetEnvelopeRadius: 1.4, requireTargetVisible: true } }).success, false);
  assert.equal(SceneRequest.safeParse({ requestId: id, projectRevision: 1, variant: "plant", requirements: DEFAULT_PLANT_REQUIREMENTS }).success, false);
});

test("native plant checks must report all five measured rules for the requested layout", () => {
  const checks = ["footprint-area", "aisle-clearance", "guard-clearance", "camera-coverage", "egress-travel"].map(c => ({ id: c, passed: true }));
  const base = { schema: "pai-blender-plant-checks-1", blenderVersion: "5.2.2 LTS", variant: "plant", layout, scope: "generated-static-geometry", physicalValidation: false };
  assert.equal(SceneChecks.safeParse({ ...base, checks }).success, true);
  assert.equal(SceneChecks.safeParse({ ...base, checks: checks.slice(0, 4) }).success, false);
  assert.equal(SceneChecks.safeParse({ ...base, checks, physicalValidation: true }).success, false);
});

test("derived hall size matches the native recipe and the reference line fits the default footprint", () => {
  assert.deepEqual(plantHall(layout), { x: 39, y: 16.05 });
  const ref = plantHall(PLANT_REFERENCE);
  assert.ok(ref.x * ref.y <= DEFAULT_PLANT_REQUIREMENTS.maxFootprintArea);
});

test("a corrected plant layout does not hide the failure of the original layout", () => {
  const project = { id, revision: 1, requirements: {}, createdAt: "2026-10-03T00:00:00Z" } as unknown as Project;
  const scene = (sid: string, aisleWidth: number, passed: boolean, at: string): SceneReview => ({
    id: sid, projectId: id, projectRevision: 1, request: { requestId: sid, projectRevision: 1, variant: "plant", layout: { ...layout, aisleWidth }, requirements: DEFAULT_PLANT_REQUIREMENTS },
    requirementDigest: "x", state: "completed", createdAt: at, receipts: [], sourceDigests: {}, files: {}, scope: "generated-static-geometry", physicalValidation: false,
    baseline: { checks: [{ id: "aisle-clearance", passed: true }] } as SceneReview["baseline"], candidate: { checks: [{ id: "aisle-clearance", passed }] } as SceneReview["candidate"],
  });
  const failed = scene("00000000-0000-4000-8000-00000000000a", 2.4, false, "2026-10-03T01:00:00Z");
  const fixed = scene("00000000-0000-4000-8000-00000000000b", 2.8, true, "2026-10-03T02:00:00Z");
  assert.notEqual(sceneKey(failed.request), sceneKey(fixed.request));
  const snapshot = { project, reviews: [], scenes: [failed, fixed], factoryCriteria: [], factoryReviews: [], feedback: [], campaigns: [], events: [], plans: [], proposals: [] } as LifecycleSnapshot;
  const cases = failingCases(snapshot);
  assert.equal(cases.length, 1); assert.equal(cases[0].runId, failed.id); assert.match(cases[0].label, /AGV 通道净宽/);
});
