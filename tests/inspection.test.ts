import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectionPlan, recordInspection } from "../src/inspection.js";
import { FAMILY_DEFAULTS } from "../src/cad.js";

const pillow = {
  id: "cad-1", projectId: "p", state: "completed", verdict: "accepted-cad-part", requirementDigest: "d".repeat(64),
  request: { variant: "pillow-block", requirements: FAMILY_DEFAULTS["pillow-block"] },
  candidate: { mass: 189.6, checks: [
    { id: "bearing-seat", passed: true, observed: { seatDiameter: 35.012, seatLength: 11.011, axisOffset: 0 }, required: { seatDiameter: [35, 35.025], seatLengthMin: 11, axisOffsetMax: 0.02 } },
    { id: "shoulder", passed: true, observed: 28, required: [17, 28.6] }, { id: "min-wall", passed: true, observed: 8, required: 5 },
    { id: "envelope", passed: true, observed: [108, 36, 55.5], required: [120, 40, 60] }] },
};
const memory = () => {
  const docs = new Map<string, unknown>(), reqs = new Map<string, string>();
  return { get: (_k: string, id: string) => docs.get(id), claim: (rid: string, _d: string, r: { id: string }) => { if (!reqs.has(rid)) { reqs.set(rid, r.id); docs.set(r.id, r); } return reqs.get(rid)!; },
    seed: (r: { id: string }) => docs.set(r.id, r) };
};
const values = (over: Record<string, number> = {}) => ({ "bearing-seat-diameter": 35.011, "bearing-seat-depth": 11.05, "shoulder-diameter": 28.02, "envelope-x": 108.05,
  "envelope-y": 36.02, "envelope-z": 55.48, "min-wall": 7.95, mass: 190.1, ...over });

test("the plan of a pillow block carries the H7 band, the frozen limits and an instrument per characteristic", () => {
  const plan = inspectionPlan(pillow as never);
  const seat = plan.find(p => p.id === "bearing-seat-diameter")!;
  assert.deepEqual([seat.lower, seat.upper, seat.unit], [35, 35.025, "mm"]);
  assert.equal(plan.find(p => p.id === "mass")!.upper, 250);
  assert.ok(plan.every(p => p.instrument && p.source && (p.lower !== undefined || p.upper !== undefined)));
  assert.throws(() => inspectionPlan({ ...pillow, verdict: "rejected" } as never), /accepted/);
});

test("measured values are judged against the plan; a bore measured outside H7 makes the part nonconforming", () => {
  const store = memory(); store.seed(pillow);
  const ok = recordInspection(store as never, "cad-1", { requestId: crypto.randomUUID(), measuredBy: "QA 张工", instrument: "CMM Zeiss Contura", partSerial: "SN-001", values: values() }, "local-maintainer");
  assert.equal(ok.verdict, "conforming"); assert.equal(ok.physicalMeasurement, true);
  const bad = recordInspection(store as never, "cad-1", { requestId: crypto.randomUUID(), measuredBy: "QA 张工", instrument: "气动量仪", partSerial: "SN-002", values: values({ "bearing-seat-diameter": 35.031 }) }, "local-maintainer");
  assert.equal(bad.verdict, "nonconforming");
  assert.deepEqual(bad.results.filter(r => !r.passed).map(r => r.id), ["bearing-seat-diameter"]);
  assert.equal(bad.results.find(r => r.id === "bearing-seat-diameter")!.deviation, 0.019);
});

test("every planned characteristic needs exactly one value; unknown ones are refused", () => {
  const store = memory(); store.seed(pillow);
  const { mass: _m, ...partial } = values();
  assert.throws(() => recordInspection(store as never, "cad-1", { requestId: crypto.randomUUID(), measuredBy: "QA", instrument: "CMM", partSerial: "1", values: partial }, "x"), /missing: mass/);
  assert.throws(() => recordInspection(store as never, "cad-1", { requestId: crypto.randomUUID(), measuredBy: "QA", instrument: "CMM", partSerial: "1", values: { ...values(), colour: 1 } }, "x"), /unknown: colour/);
});
