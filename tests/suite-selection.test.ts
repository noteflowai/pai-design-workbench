import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCases, suiteResult } from "../scripts/suite-selection.js";

// Stand-ins for the suite's cases; run() records whether a case would have started a tool.
const started: string[] = [];
const cases = ["C1", "D1", "D2", "P1"].map(id => ({ id, run: () => { started.push(id); } }));
const pick = (env: Record<string, string | undefined>) => selectCases(cases, env).selected.map(c => c.id);
const runAll = (env: Record<string, string | undefined>) => { for (const c of selectCases(cases, env).selected) c.run(); };

test("an empty effective selection fails before any case runs", () => {
  started.length = 0;
  for (const env of [{ PAI_SUITE_ONLY: "D2", PAI_SUITE_SKIP: "D2" }, { PAI_SUITE_SKIP: "C1,D1,D2,P1" },
    { PAI_SUITE_ONLY: "C1,D1", PAI_SUITE_SKIP: "D1, C1" }]) {
    assert.throws(() => runAll(env), /Suite selection is empty/);
  }
  assert.throws(() => selectCases([], {}), /Suite selection is empty/);
  assert.deepEqual(started, []);
});

test("the CI split stays non-empty and complementary; other selections keep their behaviour", () => {
  assert.deepEqual(pick({ PAI_SUITE_ONLY: "D2" }), ["D2"]);
  assert.deepEqual(pick({ PAI_SUITE_SKIP: "D2" }), ["C1", "D1", "P1"]);
  assert.deepEqual(pick({}), ["C1", "D1", "D2", "P1"]);
  assert.deepEqual(pick({ PAI_SUITE_ONLY: " ", PAI_SUITE_SKIP: "" }), ["C1", "D1", "D2", "P1"]);
  assert.deepEqual(pick({ PAI_SUITE_ONLY: "P1,C1", PAI_SUITE_SKIP: "C1" }), ["P1"]);
  assert.deepEqual(selectCases(cases, { PAI_SUITE_SKIP: "D2" }).selection, { only: null, skip: ["D2"], available: 4 });
  // A required case missing from this environment (e.g. D2 without the CAM toolchain) is an error, not a skip.
  assert.throws(() => pick({ PAI_SUITE_ONLY: "D2,X9" }), /not available in this environment: X9/);
  assert.throws(() => pick({ PAI_SUITE_SKIP: "X9" }), /not available in this environment: X9/);
});

test("zero results never report passed", () => {
  assert.equal(suiteResult([]), "failed");
  assert.equal(suiteResult([{ passed: true }]), "passed");
  assert.equal(suiteResult([{ passed: true }, { passed: false }]), "failed");
});
