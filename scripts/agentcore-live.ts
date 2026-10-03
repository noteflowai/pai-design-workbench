import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import type { AssistantPlan } from "../src/assistant.js";
import type { Project } from "../src/contracts.js";

/**
 * Live workbench -> Amazon Bedrock AgentCore check. SPENDS ONE REAL KIRO ATTEMPT on the AgentCore ledger.
 * Requires PAI_AGENTCORE_AGENT_ARN, PAI_AGENTCORE_SANDBOX_ARN and AWS credentials allowed to invoke them.
 * The local executor is deliberately unset, so both the model run and the untrusted code run remotely.
 */
const config = { ...configuration(), controllerEntrypoint: undefined, controllerDatabase: undefined, aiProfiles: undefined };
assert.ok(config.agentcoreAgentArn && config.agentcoreSandboxArn && config.cadquery, "set both AgentCore ARNs and PAI_CADQUERY_PYTHON");
const state = join(config.state, "agentcore-live", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const call = async <T>(url: string, payload?: unknown): Promise<T> => {
  const r = await app.inject({ method: payload === undefined ? "GET" : "POST", url, headers, payload: payload === undefined ? undefined : JSON.stringify(payload) });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
try {
  const caps = (await call<{ capabilities: { assistant: { transport: string; engines: string[] }; cad: { generatedCode: { available: boolean; transport: string; remote: unknown } } } }>("/api/state")).capabilities;
  assert.equal(caps.assistant.transport, "agentcore"); assert.equal(caps.cad.generatedCode.transport, "agentcore"); assert.equal(caps.cad.generatedCode.available, true);
  const template = await readFile(join(config.repository, "native/cad_template.py"), "utf8");
  const project = await call<Project>("/api/projects", { title: "AgentCore live: NEMA 17 bracket", intendedDecision: "Generated geometry only through native checks in an isolated microVM",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const t0 = Date.now();
  const thin = await call<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "generated",
    requirements: DEFAULT_CAD_REQUIREMENTS, source: { language: "cadquery-2.8", code: template.replace("T = 4.0 ", "T = 2.5 ") } });
  const thinSeconds = Math.round((Date.now() - t0) / 1000);
  assert.equal(thin.state, "completed", thin.error ?? ""); assert.equal(thin.verdict, "rejected");
  assert.deepEqual(thin.candidate!.checks.filter(c => !c.passed).map(c => c.id), ["min-wall"]);
  assert.equal(thin.sandbox?.transport, "agentcore"); assert.equal(thin.sandbox?.layers?.microvm, true);

  const t1 = Date.now();
  const plan = await call<AssistantPlan>("/api/assistant/ai", { requestId: randomUUID(), projectId: project.id,
    message: "cad-1 板厚 2.5 mm 没有通过最小壁厚。用 cad-code 工具从模板出发写一份 CadQuery 代码，把板厚改为 3.5 mm，其余保持不变。" });
  const aiSeconds = Math.round((Date.now() - t1) / 1000);
  assert.equal(plan.state, "done", JSON.stringify(plan.ai));
  const step = plan.plans.find(p => p.tool === "cad-code");
  assert.ok(step, `expected a cad-code plan: ${plan.interpretation.join(" | ")}`);
  // Confirm and execute exactly as the assistant UI does: preflight, same route, new request identity, then record the confirmation.
  await call(`/api/assistant/plans/${plan.id}/preflight`, { planId: step.id });
  const fixed = await call<CadReview>(`/api/projects/${project.id}${step.route.replace(`/projects/${project.id}`, "")}`, { ...step.payload, requestId: randomUUID() });
  const confirmed = await call<AssistantPlan>(`/api/assistant/plans/${plan.id}/confirmations`, { planId: step.id, recordKind: "cad-review", recordId: fixed.id });
  assert.equal(fixed.state, "completed", fixed.error ?? "");
  const report = { schema: "pai-agentcore-live-1", checkedAt: new Date().toISOString(), result: "passed", workbench: "local process; no local executor, ledger or Kiro keys",
    sandbox: { arn: config.agentcoreSandboxArn, remote: caps.cad.generatedCode.remote, thin: { verdict: thin.verdict, failed: ["min-wall"], seconds: thinSeconds, layers: thin.sandbox?.layers,
      adapters: thin.receipts.map(r => r.adapter) } },
    agent: { arn: config.agentcoreAgentArn, state: plan.state, engine: plan.ai?.engine?.profile, model: plan.ai?.engine?.model, attempts: plan.ai?.attempts.map(a => `${a.profile}:${a.errorKind ?? a.status}`),
      seconds: aiSeconds, tools: plan.plans.map(p => p.tool), rejected: plan.interpretation.filter(x => x.startsWith("已拒绝")).length },
    aiCodeExecuted: { match: confirmed.confirmations[0].match, verdict: fixed.verdict, failed: fixed.candidate?.checks.filter(c => !c.passed).map(c => c.id),
      minWall: fixed.candidate?.checks.find(c => c.id === "min-wall")?.observed, layers: fixed.sandbox?.layers },
    promptAndAnswerContentRecorded: false, physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/agentcore-live.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  // Preserve the full private receipt, but stdout is safe for public evidence logs.
  const publicReport = { ...report, sandbox: { ...report.sandbox, arn: "<REDACTED_SANDBOX_RUNTIME_ARN>" },
    agent: { ...report.agent, arn: "<REDACTED_AGENT_RUNTIME_ARN>" },
    publicRedaction: { fields: ["sandbox.arn", "agent.arn"], reason: "Operator references remain in the private receipt only." } };
  console.log(JSON.stringify(publicReport, null, 2));
} finally { await app.close(); }
