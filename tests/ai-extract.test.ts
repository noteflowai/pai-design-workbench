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
