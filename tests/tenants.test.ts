import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { parseTenants } from "../src/tenants.js";
import { createArtifact, type ArtifactVersion } from "../src/artifacts/registry.js";
import { saveWorkflow } from "../src/artifacts/workflows.js";
import { planning } from "./fixtures/workflows.js";

const REF = "logistics-pdptw@1.0.0";
const TENANTS = parseTenants(JSON.stringify([{ id: "acme", clientId: "acmeclient", maxConcurrentRuns: 1, maxRunsPerDay: 3 }, { id: "globex", clientId: "globexclient" }]));

async function platform() {
  const state = await mkdtemp(join(tmpdir(), "pai-tenants-"));
  const config = { ...configuration(), state, tenants: TENANTS, logisticsPython: undefined };
  const { app, store } = await createApp(config);
  const host = `127.0.0.1:${config.port}`;
  const a = await createArtifact(store, config, { adapter: "logistics-pdptw", version: "1.0.0" }, "tester");
  // Unit tests run without OR-Tools: stand in for the acceptance benchmark, then a person releases it.
  store.put("artifact", <{ id: string }>{ ...a, revision: 2, state: "validated", validation: { at: "t", passed: true, evidence: { unit: true }, runId: randomUUID(), usage: {} as never } }, 1);
  const w = saveWorkflow(store, planning(), "tester");
  const f = join(state, "p.json");
  execFileSync("python3", ["-I", "native/logistics_generate.py", "--seed", "1", "--orders", "3", "--vehicles", "1", "--output", f]);
  const problem = JSON.parse(await readFile(f, "utf8"));
  const maintainer = (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { host, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload: payload as object } : {}) });
  const as = (tenant: string | undefined) => (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/agent${url}`, headers: { host, ...(tenant ? { "x-pai-tenant": tenant } : {}), ...(payload ? { "content-type": "application/json" } : {}) },
      ...(payload ? { payload: payload as object } : {}) });
  const release = () => { const cur = store.get<ArtifactVersion>("artifact", REF)!; store.put("artifact", <{ id: string }>{ ...cur, revision: cur.revision + 1, state: "released" }, cur.revision); };
  return { app, store, w, problem, maintainer, as, release, cleanup: async () => { await app.close(); await rm(state, { recursive: true, force: true }); } };
}

test("only released artifacts in a workflow offered to the tenant can run; others see nothing", async () => {
  const p = await platform();
  try {
    const refused = await p.maintainer("POST", "/api/v1/offerings", { workflow: p.w.id, tenants: ["acme"], reason: "pilot planning" });
    assert.equal(refused.statusCode, 409, "a validated (not released) artifact cannot be offered");
    p.release();
    assert.equal((await p.maintainer("POST", "/api/v1/offerings", { workflow: p.w.id, tenants: ["nobody"], reason: "pilot planning" })).statusCode, 422);
    const offer = await p.maintainer("POST", "/api/v1/offerings", { workflow: p.w.id, tenants: ["acme"], reason: "pilot planning" });
    assert.equal(offer.statusCode, 200, offer.body);
    const acme = p.as("acme"), globex = p.as("globex");
    assert.deepEqual((await acme("GET", "/v1/tenant/catalog")).json().workflows.map((w: { id: string }) => w.id), [p.w.id]);
    assert.deepEqual((await globex("GET", "/v1/tenant/catalog")).json().workflows, []);
    assert.equal((await globex("POST", "/v1/tenant/runs", { requestId: randomUUID(), workflow: p.w.id, inputs: { problem: p.problem } })).statusCode, 404);
    const run = await acme("POST", "/v1/tenant/runs", { requestId: randomUUID(), workflow: p.w.id, inputs: { problem: p.problem } });
    assert.equal(run.statusCode, 200, run.body);
    const id = run.json().id;
    assert.equal(p.store.get<{ tenant: string }>("workflow-run", id)!.tenant, "acme");
    assert.ok(!JSON.stringify(run.json()).includes("tester"), "no operator identities in the tenant view");
    // Isolation: the other tenant cannot see, read data of, or decide the run.
    assert.equal((await globex("GET", `/v1/tenant/runs/${id}`)).statusCode, 404);
    assert.deepEqual((await globex("GET", "/v1/tenant/runs")).json().runs, []);
    assert.equal((await globex("POST", `/v1/tenant/runs/${id}/decisions`, { node: "dispatcher", approve: true, reason: "not mine" })).statusCode, 404);
    assert.equal((await acme("GET", `/v1/tenant/runs/${id}`)).statusCode, 200);
    // A maintainer rejection never shows the operator's identity to the tenant.
    const r = p.store.get<Record<string, unknown>>("workflow-run", id)!;
    p.store.put("workflow-run", { ...r, id, revision: (r.revision as number) + 1, state: "rejected", error: "dispatcher rejected by cognito:operator-sub" } as { id: string }, r.revision as number);
    const seen = (await acme("GET", `/v1/tenant/runs/${id}`)).json();
    assert.equal(seen.error, "REJECTED_BY_OPERATOR"); assert.ok(!JSON.stringify(seen).includes("cognito"));
    // Revoked: no new runs, no decisions on waiting runs, catalogue empty.
    const waiting = p.store.get<Record<string, unknown>>("workflow-run", id)!;
    p.store.put("workflow-run", { ...waiting, id, revision: (waiting.revision as number) + 1, state: "waiting-approval", error: undefined } as { id: string }, waiting.revision as number);
    assert.equal((await p.maintainer("POST", `/api/v1/offerings/${offer.json().id}/revoke`, { reason: "pilot ended" })).statusCode, 200);
    assert.deepEqual((await acme("GET", "/v1/tenant/catalog")).json().workflows, []);
    assert.equal((await acme("POST", "/v1/tenant/runs", { requestId: randomUUID(), workflow: p.w.id, inputs: { problem: p.problem } })).statusCode, 404);
    assert.equal((await acme("POST", `/v1/tenant/runs/${id}/decisions`, { node: "dispatcher", approve: true, reason: "after revocation" })).statusCode, 404, "revoked: waiting runs cannot continue");
  } finally { await p.cleanup(); }
});

test("tenant and workspace credentials never cross; browser requests get no tenant", async () => {
  const p = await platform();
  try {
    assert.equal((await p.as(undefined)("GET", "/v1/tenant/catalog")).statusCode, 403, "a workspace agent is not a tenant");
    assert.equal((await p.as("acme")("GET", "/state")).statusCode, 403, "a tenant cannot read the workspace");
    assert.equal((await p.as("acme")("GET", "/v1/objects")).statusCode, 403);
    assert.equal((await p.as("unknown")("GET", "/v1/tenant/catalog")).statusCode, 403);
    assert.equal((await p.maintainer("GET", "/api/v1/tenant/catalog")).statusCode, 403, "the internal tenant path needs tenant credentials");
    assert.equal((await p.as("acme")("POST", "/v1/offerings", { workflow: p.w.id, tenants: ["acme"], reason: "self-service" })).statusCode, 404, "tenants cannot offer");
  } finally { await p.cleanup(); }
});

test("quotas: concurrent and daily limits refuse before a run exists; a repeated request is not counted twice", async () => {
  const p = await platform();
  try {
    p.release();
    await p.maintainer("POST", "/api/v1/offerings", { workflow: p.w.id, tenants: ["acme"], reason: "pilot planning" });
    const acme = p.as("acme");
    const requestId = randomUUID();
    const first = await acme("POST", "/v1/tenant/runs", { requestId, workflow: p.w.id, inputs: { problem: p.problem } });
    assert.equal(first.statusCode, 200);
    assert.equal((await acme("POST", "/v1/tenant/runs", { requestId, workflow: p.w.id, inputs: { problem: p.problem } })).json().id, first.json().id);
    // Another tenant reusing the same requestId conflicts instead of receiving acme's run.
    await p.maintainer("POST", "/api/v1/offerings", { workflow: p.w.id, tenants: ["globex"], reason: "pilot planning" });
    assert.equal((await p.as("globex")("POST", "/v1/tenant/runs", { requestId, workflow: p.w.id, inputs: { problem: p.problem } })).statusCode, 409);
    // Concurrency: an active run blocks the next one (limit 1).
    const active = p.store.get<Record<string, unknown>>("workflow-run", first.json().id)!;
    p.store.put("workflow-run", { ...active, id: String(active.id), revision: (active.revision as number) + 1, state: "waiting-approval" } as { id: string }, active.revision as number);
    const before = p.store.count("workflow-run");
    const busy = await acme("POST", "/v1/tenant/runs", { requestId: randomUUID(), workflow: p.w.id, inputs: { problem: p.problem } });
    assert.equal(busy.statusCode, 429); assert.match(busy.body, /QUOTA_CONCURRENT/);
    assert.equal(p.store.count("workflow-run"), before, "no record for a refused request");
    const done = p.store.get<Record<string, unknown>>("workflow-run", first.json().id)!;
    p.store.put("workflow-run", { ...done, id: String(done.id), revision: (done.revision as number) + 1, state: "failed" } as { id: string }, done.revision as number);
    // Daily: 3 runs in 24 h.
    for (let i = 0; i < 2; i++) assert.equal((await acme("POST", "/v1/tenant/runs", { requestId: randomUUID(), workflow: p.w.id, inputs: { problem: p.problem } })).statusCode, 200);
    const daily = await acme("POST", "/v1/tenant/runs", { requestId: randomUUID(), workflow: p.w.id, inputs: { problem: p.problem } });
    assert.equal(daily.statusCode, 429); assert.match(daily.body, /QUOTA_DAILY/);
    const usage = (await acme("GET", "/v1/tenant/usage")).json();
    assert.equal(usage.runs, 3); assert.equal(usage.billed, false); assert.equal(usage.priceVersion, null);
    assert.equal((await p.as("globex")("GET", "/v1/tenant/usage")).json().runs, 0);
    const listed = (await p.maintainer("GET", "/api/v1/tenants")).json().tenants;
    assert.deepEqual(listed.map((t: { id: string }) => t.id), ["acme", "globex"]);
    assert.ok(!JSON.stringify(listed).includes("acmeclient"), "client ids are not shown");
  } finally { await p.cleanup(); }
});

test("PAI_TENANTS is validated: unique ids and clients, reserved workspace id refused", () => {
  assert.throws(() => parseTenants(JSON.stringify([{ id: "a1", clientId: "x" }, { id: "a1", clientId: "y" }])), /unique/);
  assert.throws(() => parseTenants(JSON.stringify([{ id: "a1", clientId: "x" }, { id: "b2", clientId: "x" }])), /unique/);
  assert.throws(() => parseTenants(JSON.stringify([{ id: "workspace", clientId: "x" }])), /reserved/);
  assert.throws(() => parseTenants(JSON.stringify([{ id: "Bad Id", clientId: "x" }])));
  assert.deepEqual(parseTenants(undefined), []);
});
