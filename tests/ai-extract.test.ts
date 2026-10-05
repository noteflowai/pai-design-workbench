import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/ai.js";

const plan = { kind: "plan", plans: [{ ref: "p1", tool: "cad-optimize", payload: { seeds: [{ parameters: { thickness: 4, width: 57, plateHeight: 46 } }] } }], answer: { text: "a } inside { a string", citations: ["cad-1"] } };
test("the reply object is found among prose, examples and several fenced blocks", () => {
  assert.deepEqual(extractJson(JSON.stringify(plan)), plan);
  assert.deepEqual(extractJson(`说明：例如 {"t": 4}。\n\n${JSON.stringify(plan)}\n以上。`), plan);
  assert.deepEqual(extractJson("```json\n{\"seed\": 1}\n```\n然后\n```json\n" + JSON.stringify(plan) + "\n```"), plan);
  assert.deepEqual(extractJson(`${JSON.stringify({ kind: "clarify" })}\n${JSON.stringify(plan)}`), plan, "the last complete reply wins");
});
test("no reply object is an error, never a guess", () => {
  assert.throws(() => extractJson("no json here"), /kind/);
  assert.throws(() => extractJson('{"seed": 1} {"broken": '), /kind/);
});

import { interpretOutput } from "../src/ai.js";
test("long prose is clipped, structure stays strict, and schema errors name the path", () => {
  const ctx = { handles: new Map(), workspace: {} } as Parameters<typeof interpretOutput>[1];
  const long = "板弯曲刚度与 t³ 成正比。".repeat(200);
  const out = interpretOutput(JSON.stringify({ kind: "answer", interpretation: Array(12).fill(long), answer: { text: long.repeat(3), citations: [] } }), ctx);
  assert.equal(out.interpretation.length, 8);
  assert.ok(out.interpretation.every(x => x.length <= 500));
  assert.ok(out.answer!.text.length <= 4000 && out.answer!.text.endsWith("…"));
  assert.throws(() => interpretOutput(JSON.stringify({ kind: "plan", plans: [{ ref: "plan-1", tool: "cad-optimize" }] }), ctx),
    (e: Error) => e.name === "ZodError" || /plans/.test(e.message));
});

test("null on an optional property means absent (the hosted Kiro reply wrote dependsOn: null)", () => {
  const ctx = { handles: new Map([["cad-1", { kind: "cad-part", id: "x", label: "cad-1" }]]), workspace: {} } as Parameters<typeof interpretOutput>[1];
  const out = interpretOutput(JSON.stringify({ kind: "answer", interpretation: ["x"], answer: { text: "t", citations: ["cad-1"] },
    plans: [{ ref: "p1", tool: "unknown-tool", title: null, rationale: null, dependsOn: null, payload: { seeds: [{ rationale: null }] } }] }), ctx);
  assert.equal(out.answer?.citations[0].handle, "cad-1");
  assert.ok(out.interpretation.some(x => /已拒绝 AI 计划 p1/.test(x)), "the plan itself is still judged by its tool contract");
  assert.throws(() => interpretOutput(JSON.stringify({ kind: null }), ctx));
});

test("visual review is refused before any claim when the executor does not accept images", async () => {
  const { createAiPlan } = await import("../src/ai.js");
  const prev = process.env.PAI_EXECUTOR_IMAGES; delete process.env.PAI_EXECUTOR_IMAGES;
  try {
    await assert.rejects(createAiPlan({} as never, { controllerEntrypoint: "/x", controllerDatabase: "/y" } as never,
      { requestId: crypto.randomUUID(), message: "look at this", attachments: [{ recordKind: "scene-review", recordId: crypto.randomUUID(), which: "candidate", file: "preview.png" }] }, () => ({}) as never),
      /VISUAL_REVIEW_NOT_AVAILABLE|not accept images/);
  } finally { if (prev !== undefined) process.env.PAI_EXECUTOR_IMAGES = prev; }
});

test("a plan for the second part family starts from that family's frozen defaults, not the bracket's", async () => {
  const { FAMILY_DEFAULTS, DEFAULT_CAD_REQUIREMENTS } = await import("../src/cad.js");
  const lastCad = { id: "c1", request: { variant: "reference", requirements: { ...DEFAULT_CAD_REQUIREMENTS, structural: { forceN: 60, leverMm: 50, safetyFactor: 2, maxDeflectionMm: 0.06 } } } };
  const ctx = { handles: new Map([["cad-1", { kind: "cad-part", id: "c1", label: "cad-1" }]]), workspace: {}, lastCad, project: { id: "p", revision: 1 } } as unknown as Parameters<typeof interpretOutput>[1];
  const out = interpretOutput(JSON.stringify({ kind: "plan", interpretation: ["6202 housing"], answer: { text: "t", citations: ["cad-1"] },
    plans: [{ ref: "p1", tool: "cad-review", title: "轴承座", payload: { variant: "pillow-block-light", requirements: {} } }] }), ctx);
  const step = out.plans[0];
  assert.deepEqual(step.payload.requirements, FAMILY_DEFAULTS["pillow-block"], "no bracket structural block or envelope carried over");
  assert.ok(!step.changes.some(c => c.direction === "relaxed"), JSON.stringify(step.changes));
});

test("a parametric pillow-block plan (short answer) carries its family and bounded parameters, and checks them", async () => {
  const { FAMILY_DEFAULTS } = await import("../src/cad.js");
  const ctx = { handles: new Map(), workspace: {}, project: { id: "p", revision: 1 } } as unknown as Parameters<typeof interpretOutput>[1];
  const parameters = { width: 92, depth: 20, baseDepth: 36, axisHeight: 30, baseThickness: 10, boltPitch: 62, seatDiameter: 35.012, shoulderDiameter: 28 };
  const out = interpretOutput(JSON.stringify({ kind: "plan", interpretation: ["x"], plans: [{ ref: "p1", tool: "cad-review", title: "t",
    payload: { variant: "parametric", family: "pillow-block", parameters, requirements: { maxMassG: 175 } } }] }), ctx);
  const step = out.plans[0];
  assert.equal(step.payload.family, "pillow-block"); assert.deepEqual(step.payload.parameters, parameters);
  assert.deepEqual(step.payload.requirements, { ...FAMILY_DEFAULTS["pillow-block"], maxMassG: 175 });
  const bad = interpretOutput(JSON.stringify({ kind: "plan", interpretation: ["x"], plans: [{ ref: "p1", tool: "cad-review", title: "t",
    payload: { variant: "parametric", family: "pillow-block", parameters: { ...parameters, seatDiameter: 36 } } }] }), ctx);
  assert.equal(bad.plans.length, 0, "a seat outside the recipe bounds is refused at plan time");
});
