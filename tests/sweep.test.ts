import { test } from "node:test";
import assert from "node:assert/strict";
import { CadRequest, DEFAULT_CAD_REQUIREMENTS } from "../src/cad.js";
import { paretoFront, SweepGrid, SweepRequest, type SweepPoint } from "../src/sweep.js";

const point = (index: number, mass: number, wall: number, feasible = true): SweepPoint => ({ index, mass, feasible, failed: feasible ? [] : ["min-wall"], seconds: 1,
  parameters: { thickness: 3, width: 60, plateHeight: 46, pilotBore: 22.5 }, checks: [{ id: "min-wall", passed: feasible, observed: wall, required: 3 }] });

test("pareto front over feasible points: lighter or more wall margin, never an infeasible point", () => {
  const pts = [point(1, 30, 2.5, false), point(2, 37, 3), point(3, 40, 3), point(4, 43, 3.5), point(5, 48, 4), point(6, 50, 3.5)];
  assert.deepEqual(paretoFront(pts, 3), [2, 4, 5]);
  assert.deepEqual(paretoFront([point(1, 30, 2.5, false)], 3), []);
});

test("sweep grids are bounded per axis and in total; parametric reviews need parameters and true provenance shape", () => {
  const grid = { thickness: [3, 4], width: [60], plateHeight: [46], pilotBore: [22.5] };
  assert.equal(SweepGrid.safeParse(grid).success, true);
  assert.equal(SweepGrid.safeParse({ ...grid, thickness: [1.5] }).success, false, "below the recipe bound");
  assert.equal(SweepGrid.safeParse({ ...grid, width: [90] }).success, false);
  assert.equal(SweepGrid.safeParse({ thickness: [2, 3, 4, 5, 6, 7], width: [50, 60, 70], plateHeight: [40, 50, 60], pilotBore: [22.5] }).success, false, "36-point cap (54 points)");
  assert.equal(SweepGrid.safeParse({ thickness: [2, 3, 4, 5, 6, 7], width: [50, 60, 70], plateHeight: [40, 60], pilotBore: [22.5] }).success, true, "exactly 36 points");
  assert.equal(SweepGrid.safeParse({ ...grid, extra: [1] }).success, false);
  assert.equal(SweepRequest.safeParse({ requestId: "00000000-0000-4000-8000-000000000001", projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS, grid }).success, true);
  const base = { requestId: "00000000-0000-4000-8000-000000000001", projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS };
  const parameters = { thickness: 3, width: 60, plateHeight: 46, pilotBore: 22.5 };
  assert.equal(CadRequest.safeParse({ ...base, variant: "parametric" }).success, false);
  assert.equal(CadRequest.safeParse({ ...base, variant: "parametric", parameters }).success, true);
  assert.equal(CadRequest.safeParse({ ...base, variant: "reference", parameters }).success, false);
  assert.equal(CadRequest.safeParse({ ...base, variant: "reference", fromSweep: { sweepId: base.requestId, point: 1 } }).success, false);
});
