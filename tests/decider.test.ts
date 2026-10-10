import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config.js";
import { LANES, SUGGEST_AT, suggestLane } from "../src/decider.js";
import { createPlan } from "../src/assistant.js";
import { Store } from "../src/store.js";

const URL_OK = "http://127.0.0.1:8801/v1/systemone";
const answer = (choice: string, confidence: number, noul = 0.1) => async () => new Response(JSON.stringify({ model: "strands-decider-2B-qwen3.5-v1-2610",
  answers: { lane: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } }, relaxes: { type: "noul", noul } }, latency_ms: 200 }), { status: 200 });

test("a suggestion needs confidence >= the threshold and a known lane; it never carries authority", async () => {
  const config = { ...configuration(), deciderUrl: URL_OK };
  const hi = await suggestLane(config, "在 2.5 到 4 mm 之间扫描支架", answer("cad-sweep", 0.95, 0.7) as typeof fetch);
  assert.deepEqual({ lane: hi?.lane, authority: hi?.authority, threshold: hi?.threshold, relaxes: hi?.relaxesProbability }, { lane: "cad-sweep", authority: "none", threshold: SUGGEST_AT, relaxes: 0.7 });
  assert.equal((await suggestLane(config, "x", answer("cad-sweep", 0.89) as typeof fetch))?.lane, null, "below threshold: no lane");
  assert.equal((await suggestLane(config, "x", answer("rm -rf", 0.99) as typeof fetch))?.lane, null, "unknown option: no lane");
});

test("unconfigured, failing, slow or malformed Decider means no suggestion (fail closed)", async () => {
  const base = configuration();
  assert.equal(await suggestLane({ ...base, deciderUrl: undefined }, "x", (() => { throw new Error("must not be called"); }) as typeof fetch), undefined);
  const config = { ...base, deciderUrl: URL_OK };
  for (const f of [async () => new Response("no", { status: 500 }), async () => new Response("{\"answers\":{}}", { status: 200 }),
    async () => { throw new TypeError("connection refused"); }, async () => new Response("not json", { status: 200 })]) {
    assert.equal(await suggestLane(config, "x", f as typeof fetch), undefined);
  }
  // A server that never answers: the call gives up at its own timeout (the fake keeps the event loop alive meanwhile).
  const slow = ((_: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    const hold = setTimeout(() => reject(new Error("not aborted")), 10_000);
    init.signal!.addEventListener("abort", () => { clearTimeout(hold); reject(new DOMException("timeout", "TimeoutError")); });
  })) as typeof fetch;
  const t = Date.now(); assert.equal(await suggestLane(config, "x", slow), undefined); assert.ok(Date.now() - t < 6000);
});

test("PAI_DECIDER_URL accepts only loopback or private /v1/systemone endpoints", () => {
  const withUrl = (u: string) => { const prev = process.env.PAI_DECIDER_URL; process.env.PAI_DECIDER_URL = u; try { return configuration().deciderUrl; } finally { if (prev === undefined) delete process.env.PAI_DECIDER_URL; else process.env.PAI_DECIDER_URL = prev; } };
  assert.equal(withUrl(URL_OK), URL_OK);
  assert.equal(withUrl("http://10.0.3.7:8000/v1/systemone"), "http://10.0.3.7:8000/v1/systemone");
  for (const bad of ["https://decider.example.com/v1/systemone", "http://127.0.0.1:8801/other", "ftp://127.0.0.1/v1/systemone", "http://u:p@127.0.0.1/v1/systemone"]) {
    assert.throws(() => withUrl(bad), /PAI_DECIDER_URL/, bad);
  }
});

test("the Decider is asked only when the rules found no tool; its suggestion is recorded on the plan", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-decider-"));
  const store = new Store(join(state, "workbench.sqlite"));
  try {
    let asked = 0;
    const suggest = async () => { asked++; return { engine: "strands-decider" as const, model: "m", lane: "cad-sweep" as const, confidence: 0.95, threshold: SUGGEST_AT, relaxesProbability: 0.1, latencyMs: 5, authority: "none" as const }; };
    const matched = await createPlan(store, { requestId: randomUUID(), message: "评估 NEMA 17 电机支架轻量化方案，壁厚不低于 3 mm，质量不超过 60 g" }, false, suggest);
    assert.equal(matched.unmatched, false); assert.equal(asked, 0); assert.equal(matched.suggestion, undefined);
    const unmatched = await createPlan(store, { requestId: randomUUID(), message: "帮我看看哪一种方案最划算" }, false, suggest);
    assert.equal(unmatched.unmatched, true); assert.equal(asked, 1);
    assert.equal(unmatched.suggestion?.lane, "cad-sweep");
    assert.ok(unmatched.plans.every(p => ["create-project", "update-requirements"].includes(p.tool)), "a suggestion adds no native step");
    assert.ok(Object.keys(LANES).includes(unmatched.suggestion!.lane!));
  } finally { store.close(); await rm(state, { recursive: true, force: true }); }
});

test("a repeated requestId returns the recorded plan without asking the Decider again; a conflicting one asks nothing", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-decider-rep-"));
  const store = new Store(join(state, "workbench.sqlite"));
  try {
    let asked = 0;
    const suggest = async () => { asked++; return undefined; };
    const requestId = randomUUID(), message = "帮我看看哪一种方案最划算";
    const first = await createPlan(store, { requestId, message }, false, suggest);
    const again = await createPlan(store, { requestId, message }, false, suggest);
    assert.equal(again.id, first.id); assert.equal(asked, 1);
    await assert.rejects(createPlan(store, { requestId, message: "另一句话" }, false, suggest), /REQUEST_CONFLICT|cannot be reused/);
    assert.equal(asked, 1);
  } finally { store.close(); await rm(state, { recursive: true, force: true }); }
});

test("an answer outside the offered lanes is withheld as unknown-option, not shown as low confidence", async () => {
  const s = await suggestLane({ ...configuration(), deciderUrl: URL_OK }, "x", answer("rm -rf", 0.99) as typeof fetch);
  assert.deepEqual({ lane: s?.lane, withheld: s?.withheld }, { lane: null, withheld: "unknown-option" });
  const low = await suggestLane({ ...configuration(), deciderUrl: URL_OK }, "x", answer("cad-sweep", 0.5) as typeof fetch);
  assert.equal(low?.withheld, "below-threshold");
});
