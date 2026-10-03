import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";
import type { AssistantPlan } from "../src/assistant.js";

const POOL = "ap-northeast-1_TestPool1", CLIENT = "agentclient0001", HOST = "pai.example.test";
const ISS = `https://cognito-idp.ap-northeast-1.amazonaws.com/${POOL}`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function token(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ alg: "RS256", kid: "test-key", typ: "JWT" }) + "." + b64({ iss: ISS, sub: CLIENT, client_id: CLIENT, token_use: "access",
    scope: "pai-agent/read pai-agent/propose", iat: now, exp: now + 600, jti: randomUUID(), ...claims });
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
}
const task = { title: "Line", intendedDecision: "Plant layout agent access",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };

async function app(hosted: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "pai-agent-"));
  const config = { ...configuration(), state: dir, controllerEntrypoint: undefined, controllerDatabase: undefined, albAuth: undefined,
    ...(hosted ? { publicOrigin: `https://${HOST}`, agentAuth: { userPoolId: POOL, clientIds: [CLIENT], jwks: { keys: [jwk] } } } : {}) };
  const made = await createApp(config, {} as Adapters);
  const project = made.workbench.createProject(task);
  const host = hosted ? HOST : `127.0.0.1:${config.port}`;
  const call = (method: "GET" | "POST", url: string, headers: Record<string, string> = {}, payload?: unknown) =>
    made.app.inject({ method, url, headers: { host, ...(payload ? { "content-type": "application/json" } : {}), ...headers }, payload: payload ? JSON.stringify(payload) : undefined });
  return { ...made, project, call, cleanup: async () => { await made.app.close(); await rm(dir, { recursive: true, force: true }); } };
}
const proposal = (projectId: string) => ({ requestId: randomUUID(), projectId, agent: "agentforge-session", intent: "6 工位产线",
  output: { kind: "plan", plans: [{ ref: "p1", tool: "plant-layout", payload: { layout: { stations: 6, stationPitch: 4.5, aisleWidth: 2.8, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 } } }] } });

test("hosted agent API: allowlisted routes need a verified Cognito access token with the route's scope", async () => {
  const s = await app(true);
  try {
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
    assert.equal((await s.call("GET", "/api/agent/state")).statusCode, 401, "no token");
    assert.equal((await s.call("GET", "/api/agent/state", bearer(token({ client_id: "otherclient" })))).statusCode, 401, "unknown client");
    assert.equal((await s.call("GET", "/api/agent/state", bearer(token({ token_use: "id" })))).statusCode, 401, "id token");
    assert.equal((await s.call("GET", "/api/agent/state", bearer(token({ exp: Math.floor(Date.now() / 1000) - 10 })))).statusCode, 401, "expired");
    assert.equal((await s.call("GET", "/api/agent/state", bearer(token({ iss: "https://evil.example" })))).statusCode, 401, "issuer");
    const forged = token().split("."); forged[1] = b64({ iss: ISS, client_id: CLIENT, token_use: "access", scope: "pai-agent/read", exp: 9e9 });
    assert.equal((await s.call("GET", "/api/agent/state", bearer(forged.join(".")))).statusCode, 401, "signature");
    const state = await s.call("GET", "/api/agent/state", bearer(token()));
    assert.equal(state.statusCode, 200); assert.equal(state.json().projects[0].id, s.project.id);
    assert.equal((await s.call("GET", `/api/agent/assistant/context?projectId=${s.project.id}`, bearer(token({ scope: "pai-agent/read" })))).statusCode, 200);
    // Authority-bearing or unlisted routes do not exist under /api/agent.
    for (const [m, u] of [["POST", "/api/agent/feedback"], ["POST", `/api/agent/assistant/plans/${randomUUID()}/confirmations`], ["POST", `/api/agent/projects/${s.project.id}/scenes`],
      ["GET", "/api/agent/releases"], ["GET", "/api/agent/state/../releases"]] as const) {
      assert.equal((await s.call(m, u, bearer(token()), m === "POST" ? {} : undefined)).statusCode, 404, `${m} ${u}`);
    }
    // Proposing needs the propose scope; a read-only token is refused.
    assert.equal((await s.call("POST", "/api/agent/assistant/external-plans", bearer(token({ scope: "pai-agent/read" })), proposal(s.project.id))).statusCode, 401);
    // A browser cannot ride the agent route.
    assert.equal((await s.call("GET", "/api/agent/state", { ...bearer(token()), cookie: "PAIAuthSession=x" })).statusCode, 403);
    const r = await s.call("POST", "/api/agent/assistant/external-plans", { ...bearer(token()), "x-pai-agent-session": "af-sess-42" }, proposal(s.project.id));
    assert.equal(r.statusCode, 200, r.body);
    const plan = r.json() as AssistantPlan;
    assert.deepEqual(plan.external, { agent: "agentforge-session", via: "mcp", verified: true, clientId: CLIENT, session: "af-sess-42" });
    assert.equal(plan.authority, "none"); assert.equal(plan.plans[0].tool, "plant-layout"); assert.equal(plan.plans[0].requiresConfirmation, true);
    // The browser path is unaffected by agent tokens: the regular route still needs its own (here: open) path.
    assert.equal((await s.call("GET", "/api/state")).statusCode, 200);
  } finally { await s.cleanup(); }
});

test("loopback agent API needs no token and records the proposal as unverified", async () => {
  const s = await app(false);
  try {
    assert.equal((await s.call("GET", "/api/agent/state")).statusCode, 200);
    const plan = (await s.call("POST", "/api/agent/assistant/external-plans", {}, proposal(s.project.id))).json() as AssistantPlan;
    assert.deepEqual(plan.external, { agent: "agentforge-session", via: "mcp", verified: false });
    assert.equal((await s.call("POST", "/api/agent/feedback", {}, {})).statusCode, 404);
  } finally { await s.cleanup(); }
});
