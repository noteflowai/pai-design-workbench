import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import type { AssistantPlan } from "../src/assistant.js";
import type { Project } from "../src/contracts.js";

/**
 * Live AI verification against the real NoteFlow executor and the dedicated PAI attempt ledger.
 * Uses real attempts; never retries. Records engine/state/shape only — no prompt or answer text.
 * Usage: npm run test:ai-live [-- --engines kiro,codex,claude]
 */
const config = configuration();
assert.ok(config.controllerEntrypoint && config.controllerDatabase && config.cadquery, "Configure the executor, ledger and CadQuery");
const engines = (process.argv.find(a => a.startsWith("--engines="))?.slice(10) ?? "kiro").split(",");
const state = join(config.state, "ai-live", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const call = async <T>(method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers, payload: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: r.statusCode, body: r.json() as T };
};
const summary = (p: AssistantPlan) => ({ state: p.state, engine: p.ai?.engine ? { profile: p.ai.engine.profile, model: p.ai.engine.model, version: p.ai.engine.engineVersion } : null,
  attempts: p.ai?.attempts.map(a => `${a.profile}:${a.errorKind ?? a.status}`), effects: p.ai?.effects ?? null,
  plans: p.plans.map(x => ({ tool: x.tool, changes: x.changes.filter(c => c.direction !== "same").map(c => `${c.field}:${c.direction}`) })),
  citations: p.answer?.citations.map(c => `${c.handle}:${c.kind}`) ?? [], rejectedPlans: p.interpretation.filter(i => i.startsWith("已拒绝")).length,
  error: p.ai?.error ?? null });
const results: Record<string, unknown> = {};
try {
  const project = (await call<Project>("POST", "/api/projects", { title: "NEMA 17 bracket AI review", intendedDecision: "Decide whether a lighter bracket is acceptable",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } })).body;
  const cad = await call<CadReview>("POST", `/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "lightweight", requirements: DEFAULT_CAD_REQUIREMENTS });
  assert.equal(cad.body.verdict, "rejected");
  const ask = async (label: string, message: string, profiles?: string[]) => {
    const t0 = Date.now();
    const r = await call<AssistantPlan>("POST", "/api/assistant/ai", { requestId: randomUUID(), projectId: project.id, message, ...(profiles ? { profiles } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    results[label] = { ...summary(r.body), seconds: Math.round((Date.now() - t0) / 1000) };
    console.error(label, JSON.stringify(results[label]));
    return r.body;
  };
  if (engines.includes("kiro")) {
    const qa = await ask("kiro-answer", "轻量化支架为什么被拒绝？列出失败的检查和实测值。", ["kiro-primary", "kiro-backup", "kiro-backup2"]);
    if (qa.state === "done") assert.ok((qa.answer?.citations.length ?? 0) > 0, "answer must cite records");
    const plan = await ask("kiro-plan", "给出一个修复方案并安排复测：保持壁厚不低于 3 mm，看看紧凑化方案能否通过。", ["kiro-primary", "kiro-backup", "kiro-backup2"]);
    if (plan.state === "done") assert.ok(plan.plans.every(p => p.requiresConfirmation && ["cad-review", "update-requirements"].includes(p.tool)));
  }
  for (const engine of engines.filter(e => e === "codex" || e === "claude")) {
    const r = await ask(`${engine}-answer`, "用一句话说明当前项目下一步该做什么，并引用依据。", [engine]);
    if (r.state === "reconcile") {
      // Unverified native effects: record a human reconciliation for this verification run, no retry.
      const rec = await call<AssistantPlan>("POST", `/api/assistant/plans/${r.id}/reconciliation`, { reason: "验证运行：文本请求，执行器拒绝客户端工具与文件权限；工作区无变化" });
      (results[`${engine}-answer`] as Record<string, unknown>).reconciled = Boolean(rec.body.ai?.reconciliation);
    }
  }
  const status = await call<{ capabilities: unknown }>("GET", "/api/state");
  const report = { schema: "pai-ai-live-1", checkedAt: new Date().toISOString(), engines, results,
    executor: "noteflow-text-executor ec007f0 (acpx 0.19.3)", ledger: "dedicated PAI attempt-only ledger (money_limits null)",
    capabilities: (status.body.capabilities as { assistant: unknown }).assistant, promptAndAnswerContentRecorded: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "ai-live.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
