import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";
import type { AssistantPlan } from "../src/assistant.js";
import { validRuntimeArn } from "../src/agentcore.js";

const AGENT = "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/pai_kiro_agent-AbCdEf0123";
const SANDBOX = "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/pai_cad_sandbox-AbCdEf0123";
const out = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";
type Call = { arn: string; session: string; body: Record<string, unknown> };
type Responder = (call: Call) => { status: number; body: unknown };

/** AgentCore data-plane emulator (AWS_ENDPOINT_URL_BEDROCK_AGENTCORE): records calls, answers via the current responder. */
async function emulator() {
  const calls: Call[] = [];
  let respond: Responder = () => ({ status: 500, body: { error: "NO_RESPONDER" } });
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", c => { text += c; });
    req.on("end", () => {
      const m = /^\/runtimes\/([^/]+)\/invocations/.exec(req.url ?? "");
      const call = { arn: decodeURIComponent(m?.[1] ?? ""), session: String(req.headers["x-amzn-bedrock-agentcore-runtime-session-id"] ?? ""), body: JSON.parse(text || "{}") };
      calls.push(call);
      const r = respond(call);
      res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
  process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.AWS_ACCESS_KEY_ID = "test"; process.env.AWS_SECRET_ACCESS_KEY = "test"; delete process.env.AWS_SESSION_TOKEN; delete process.env.AWS_PROFILE;
  return { calls, set: (r: Responder) => { respond = r; },
    close: async () => { delete process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE; await new Promise(ok => server.close(ok)); } };
}

const report = (runId: string, answer: string) => JSON.stringify({ flow_status: "completed", report: { schema_version: 1, run_id: runId, action: "done",
  reason: "saved answer; no repeat dispatch", publication_approved: false,
  result: { answer, effects: "none", requested: { profile: "kiro-primary" }, observed: { model: "claude-opus-5.5", engine_version: "2.24.0", model_evidence: "acp_advertised" } } } });

test("AgentCore runtime ARNs are validated", () => {
  assert.equal(validRuntimeArn(AGENT), AGENT);
  assert.equal(validRuntimeArn(undefined), undefined);
  for (const bad of ["arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/../x", "https://example.com", "arn:aws:lambda:ap-northeast-1:111122223333:function:x"]) {
    assert.throws(() => validRuntimeArn(bad), bad);
  }
});

test("AI through the AgentCore executor: same report checks, Kiro only, uncertain outcomes reconcile, never retried", async () => {
  const em = await emulator();
  const dir = await mkdtemp(join(tmpdir(), "pai-agentcore-"));
  const config = { ...configuration(), state: dir, controllerEntrypoint: undefined, controllerDatabase: undefined, agentcoreAgentArn: AGENT, cadquery: undefined };
  const { app, workbench } = await createApp(config, {} as Adapters);
  try {
    const project = workbench.createProject({ title: "Bracket", intendedDecision: "Check the remote engine path end to end",
      requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
    const h = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
    const call = async (url: string, payload?: unknown) => {
      const r = await app.inject({ method: payload === undefined ? "GET" : "POST", url, headers: h, payload: payload === undefined ? undefined : JSON.stringify(payload) });
      return { status: r.statusCode, body: r.json() };
    };
    const ask = async (message: string, extra: Record<string, unknown> = {}) => call("/api/assistant/ai", { requestId: randomUUID(), projectId: project.id, message, ...extra });
    const caps = (await call("/api/state")).body.capabilities.assistant;
    assert.deepEqual(caps.engines, ["kiro-primary", "kiro-backup", "kiro-backup2"]); assert.equal(caps.transport, "agentcore");

    em.set(c => ({ status: 200, body: { role: "agent", op: "text-proposal", exitCode: 0, timedOut: false, seconds: 21,
      report: report(String(c.body.run_id), out({ kind: "answer", answer: { text: "project 冻结了需求 v1。", citations: ["project"] } })),
      attempts: [{ profile: "kiro-primary", status: "succeeded", errorKind: null, model: "claude-opus-5.5", engineVersion: "2.24.0", effects: "none", workStarted: true }],
      ledger: { exists: true, state: "ready", dayAdmissionsUsed: 1 } } }));
    let r = await ask("任务冻结了什么？");
    let plan = r.body as AssistantPlan;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(plan.state, "done"); assert.equal(plan.ai!.engine!.profile, "kiro-primary"); assert.equal(plan.answer!.citations[0].handle, "project");
    assert.deepEqual(plan.ai!.attempts.map(a => `${a.profile}:${a.status}`), ["kiro-primary:succeeded"]);
    const sent = em.calls.at(-1)!;
    assert.equal(sent.arn, AGENT); assert.equal(sent.body.op, "text-proposal"); assert.equal(sent.body.run_id, `pai-ai-${plan.id}`);
    assert.deepEqual(sent.body.profiles, ["kiro-primary", "kiro-backup", "kiro-backup2"]);
    assert.ok(sent.session.length >= 33, "AgentCore session ids must be at least 33 characters");

    // A report claiming "done" for another run or with unknown effects is not an answer.
    em.set(c => ({ status: 200, body: { exitCode: 0, timedOut: false, report: report(String(c.body.run_id), out({ kind: "clarify" })).replace('"effects":"none"', '"effects":"unknown"'), attempts: [] } }));
    plan = (await ask("影响未知")).body as AssistantPlan;
    assert.equal(plan.state, "reconcile");
    await call(`/api/assistant/plans/${plan.id}/reconciliation`, { reason: "远端回执显示没有工具活动" });

    const before = em.calls.length;
    em.set(() => ({ status: 200, body: { exitCode: null, timedOut: true, seconds: 470, report: "", attempts: [] } }));
    plan = (await ask("超时")).body as AssistantPlan;
    assert.equal(plan.state, "reconcile"); assert.equal(em.calls.length, before + 1, "exactly one remote call");
    await call(`/api/assistant/plans/${plan.id}/reconciliation`, { reason: "远端执行器超时；没有工具活动" });

    em.set(() => ({ status: 502, body: { error: "BAD" } }));
    plan = (await ask("传输失败")).body as AssistantPlan;
    assert.equal(plan.state, "reconcile"); assert.match(plan.ai!.error ?? "", /AGENTCORE_CALL_FAILED/); assert.equal(em.calls.length, before + 2);
    await call(`/api/assistant/plans/${plan.id}/reconciliation`, { reason: "AgentCore 返回 502；未进入执行器" });

    r = await ask("用 Codex", { profiles: ["codex"] });
    assert.equal(r.status, 422); assert.equal(r.body.error, "AI_PROFILE_NOT_ENABLED"); assert.equal(em.calls.length, before + 2);
  } finally { await app.close(); await em.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the AgentCore sandbox is used only when its own probe shows a microVM without an internet route", async () => {
  const em = await emulator();
  const cases: [unknown, boolean, RegExp?][] = [
    [{ microvm: true, network: { internet: true }, bubblewrap: { active: true }, arch: "aarch64" }, false, /互联网/],
    [{ microvm: false, network: { internet: false }, bubblewrap: { active: true }, arch: "aarch64" }, false, /microVM/],
    [{ microvm: true, network: { internet: false }, bubblewrap: { active: true }, arch: "aarch64", version: "t" }, true],
  ];
  try {
    for (const [probe, available, reason] of cases) {
      const dir = await mkdtemp(join(tmpdir(), "pai-agentcore-cad-"));
      em.set(c => c.body.op === "probe" ? { status: 200, body: probe } : { status: 400, body: { error: "UNEXPECTED" } });
      // A distinct state path keeps each probe uncached.
      const config = { ...configuration(), state: dir, cadquery: "/usr/bin/python3", agentcoreSandboxArn: SANDBOX };
      const { app } = await createApp(config, {} as Adapters);
      try {
        const g = (await app.inject({ url: "/api/state", headers: { host: `127.0.0.1:${config.port}` } })).json().capabilities.cad.generatedCode;
        assert.equal(g.available, available, JSON.stringify(g));
        if (reason) assert.match(g.reason, reason); else assert.equal(g.transport, "agentcore");
      } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
    }
    assert.ok(em.calls.every(c => c.arn === SANDBOX && c.body.op === "probe"));
  } finally { await em.close(); }
});
