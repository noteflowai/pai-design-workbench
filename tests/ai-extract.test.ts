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
