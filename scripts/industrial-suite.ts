import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { command } from "../src/adapters.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import { DEFAULT_FACTORY_CRITERIA, REVIEWED_SAMPLE, type FactoryCriteria, type FactoryReview } from "../src/factory.js";
import { sha256 } from "../src/domain.js";
import type { Project, Review } from "../src/contracts.js";
import type { SceneReview } from "../src/scenes.js";
import type { AssistantPlan } from "../src/assistant.js";

/**
 * Representative industrial design test cases across every native lane. Each case states an
 * expectation fixed before execution; "passed" means the native result matched it, not that a
 * design was accepted. Nothing here is physical validation.
 */
const config = configuration();
assert.ok(config.blender && config.cadquery, "Run npm run setup:native and npm run setup:cad first");
const state = join(config.state, "industrial-suite", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const call = async (method: "POST" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers, payload: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: r.statusCode, body: r.json() };
};
const ok = async <T>(method: "POST" | "GET", url: string, payload?: unknown) => {
  const r = await call(method, url, payload); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as T;
};
type Case = { id: string; domain: string; title: string; tool: string; rationale: string; expected: string; run: () => Promise<{ actual: string; evidence: Record<string, unknown>; matched: boolean }> };
const project = await ok<Project>("POST", "/api/projects", { title: "Industrial design test suite", intendedDecision: "Check representative design decisions across native tools",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
const P = `/api/projects/${project.id}`;
const failed = (c?: { checks: { id: string; passed: boolean }[] }) => c?.checks.filter(x => !x.passed).map(x => x.id) ?? [];
const robot = async (candidate: string) => ok<Review>("POST", `${P}/reviews`, { requestId: randomUUID(), projectRevision: 1, candidate });
const scene = (variant: string, maxFootprintArea = 12) => ok<SceneReview>("POST", `${P}/scenes`, { requestId: randomUUID(), projectRevision: 1, variant,
  requirements: { maxFootprintArea, targetEnvelopeRadius: 1.4, requireTargetVisible: true } });
const cad = (variant: string, requirements = DEFAULT_CAD_REQUIREMENTS) => ok<CadReview>("POST", `${P}/cad`, { requestId: randomUUID(), projectRevision: 1, variant, requirements });
const lost = (r: Review) => r.stress!.pairs.filter(p => p.condition === r.candidate && p.reference_success && !p.condition_success).map(p => p.seed);

const cases: Case[] = [
  { id: "R1", domain: "机器人感知设计", title: "检查相机外参偏移 +0.12 m", tool: "Robot Reel + EvalArc", rationale: "感知布局改动常提高平均成功率却丢失原本成功的工况；需按配对种子保留回归。",
    expected: "rejected；丢失 seed 9；Holm p 不支持显著改善", run: async () => {
      const r = await robot("camera"), t = r.stress!.paired_exact_test.comparisons.find(c => c.condition === "camera")!;
      return { matched: r.decision?.verdict === "rejected" && JSON.stringify(lost(r)) === "[9]", actual: `${r.decision?.verdict}；camera ${r.stress!.conditions.find(c => c.id === "camera")!.successes}/10 vs 基准 5/10；丢失 seed ${lost(r).join(",")}；Holm p=${t.holm_adjusted_p}`,
        evidence: { reviewId: r.id, blockingChanges: r.diff?.blocking_changes, holmP: t.holm_adjusted_p } };
    } },
  { id: "R2", domain: "机器人感知设计", title: "照明降至基准 25%", tool: "Robot Reel + EvalArc", rationale: "低照度是常见现场条件；同一模型在记录样本上的成功率下限与回归同时检查。",
    expected: "rejected；成功率低于 50% 且丢失基准成功", run: async () => {
      const r = await robot("dim"), s = r.stress!.conditions.find(c => c.id === "dim")!.successes;
      return { matched: r.decision?.verdict === "rejected" && s < 5 && lost(r).length > 0, actual: `${r.decision?.verdict}；dim ${s}/10；丢失 seed ${lost(r).join(",")}`, evidence: { reviewId: r.id } };
    } },
  { id: "B1", domain: "工作单元布局（Blender）", title: "检查相机视线被遮挡", tool: "Blender 5.2 + EvalArc", rationale: "工作单元布局中安全围栏/设备遮挡相机是典型视觉检测失效；用原生射线与投影检查，而非渲染外观判断。",
    expected: "rejected；候选射线首先命中遮挡物；EvalArc 1 项回归", run: async () => {
      const s = await scene("occluded");
      return { matched: s.verdict === "rejected" && s.rays?.candidate?.firstHit === "Visibility obstruction" && s.diff?.blocking_changes === 1,
        actual: `${s.verdict}；候选首个命中 ${s.rays?.candidate?.firstHit}；blocking ${s.diff?.blocking_changes}`, evidence: { sceneId: s.id, stages: s.stages?.candidate?.length } };
    } },
  { id: "B2", domain: "工作单元布局（Blender）", title: "无遮挡基准布局", tool: "Blender 5.2 + EvalArc", rationale: "正向对照：同一配方在无遮挡时三项静态检查全部通过。",
    expected: "accepted-static-scene；射线首先命中目标", run: async () => {
      const s = await scene("clear");
      return { matched: s.verdict === "accepted-static-scene" && s.rays?.candidate?.firstHit === "Target", actual: `${s.verdict}；首个命中 ${s.rays?.candidate?.firstHit}`, evidence: { sceneId: s.id } };
    } },
  { id: "B3", domain: "工作单元布局（Blender）", title: "车间面积预算收紧到 10 m²", tool: "Blender 5.2 + EvalArc", rationale: "需求收紧后基准与候选都超限：应拒绝，但这不是候选引入的回归（EvalArc 0 项）。",
    expected: "rejected；footprint-area 失败；blocking 0", run: async () => {
      const s = await scene("clear", 10);
      return { matched: s.verdict === "rejected" && JSON.stringify(failed(s.candidate)) === '["footprint-area"]' && s.diff?.blocking_changes === 0,
        actual: `${s.verdict}；失败 ${failed(s.candidate).join(",")}；blocking ${s.diff?.blocking_changes}`, evidence: { sceneId: s.id } };
    } },
  { id: "C1", domain: "机械零件（CAD）", title: "NEMA 17 电机支架基准设计", tool: "CadQuery 2.8 / OCCT 7.9 + EvalArc", rationale: "步进电机安装支架是自动化设备最常见的定制机加工件；接口、壁厚、孔边距、质量与装配干涉都在 B-Rep 上实测。",
    expected: "accepted-cad-part；STEP 重新导入体积一致", run: async () => {
      const c = await cad("reference");
      const out = join(state, "c1-reopen.json");
      const r = await command(config.cadquery!, ["-I", "-W", "ignore", join(config.repository, "native/cad_reopen.py"), join(state, "cad", c.id, "candidate/part.step"), out], config.repository, undefined, 120_000);
      const reopen = JSON.parse(await readFile(out, "utf8"));
      const same = r.exitCode === 0 && reopen.valid && Math.abs(reopen.volume - c.candidate!.volume) < 0.01 * c.candidate!.volume;
      return { matched: c.verdict === "accepted-cad-part" && same, actual: `${c.verdict}；${c.candidate!.mass} g；STEP 重导入体积 ${reopen.volume} mm³（原 ${c.candidate!.volume}）`,
        evidence: { cadId: c.id, stepSha256: c.files["candidate/part.step"], reopen } };
    } },
  { id: "C2", domain: "机械零件（CAD）", title: "轻量化：板厚 4 → 2.5 mm", tool: "CadQuery 2.8 / OCCT 7.9 + EvalArc", rationale: "减重是最常见的设计迭代；质量变好时仍需守住最小壁厚（刚度/加工）约束。",
    expected: "rejected；仅 min-wall 失败；质量下降", run: async () => {
      const c = await cad("lightweight");
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["min-wall"]' && c.candidate!.mass < c.baseline!.mass,
        actual: `${c.verdict}；失败 ${failed(c.candidate).join(",")}；${c.baseline!.mass} → ${c.candidate!.mass} g`, evidence: { cadId: c.id } };
    } },
  { id: "C3", domain: "机械零件（CAD）", title: "止口孔 Ø22.5 → Ø21.5", tool: "CadQuery 2.8 / OCCT 7.9 + EvalArc", rationale: "标准件接口尺寸错误是装配返工的主要来源；用 NEMA 17 止口 Ø22 做布尔干涉检查。",
    expected: "rejected；nema17-interface 与 motor-interference 失败", run: async () => {
      const c = await cad("undersize-bore"), i = c.candidate!.checks.find(x => x.id === "motor-interference")!;
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["nema17-interface","motor-interference"]',
        actual: `${c.verdict}；失败 ${failed(c.candidate).join(",")}；干涉体积 ${(i as { observed?: number }).observed} mm³`, evidence: { cadId: c.id } };
    } },
  { id: "C4", domain: "机械零件（CAD）", title: "紧凑化：降低安装板高度与宽度", tool: "CadQuery 2.8 / OCCT 7.9 + EvalArc", rationale: "压缩外形会让紧固孔靠近边缘；1.5×d 边距是常用 DFM 经验规则。",
    expected: "rejected；仅 hole-edge-distance 失败", run: async () => {
      const c = await cad("compact"), e = c.candidate!.checks.find(x => x.id === "hole-edge-distance")! as { observed?: number; required?: number };
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["hole-edge-distance"]',
        actual: `${c.verdict}；最不利孔边距 ${e.observed} mm < ${e.required} mm`, evidence: { cadId: c.id } };
    } },
  { id: "C5", domain: "机械零件（CAD）", title: "质量预算收紧到 40 g", tool: "CadQuery 2.8 / OCCT 7.9 + EvalArc", rationale: "需求变化使基准也不满足：结论拒绝，但 EvalArc 不把它误报为候选回归。",
    expected: "rejected；mass 失败；blocking 0", run: async () => {
      const c = await cad("reference", { ...DEFAULT_CAD_REQUIREMENTS, maxMassG: 40 });
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["mass"]' && c.diff?.blocking_changes === 0,
        actual: `${c.verdict}；${c.candidate!.mass} g > 40 g；blocking ${c.diff?.blocking_changes}`, evidence: { cadId: c.id } };
    } },
  { id: "F1", domain: "工厂维护与能源", title: "预测性维护 + 需量控制方案（默认标准）", tool: "Robot Reel Factory Twin v0.18.0", rationale: "净产出 +133 的方案仍有退化种子与 EV 服务不足；逐种子保留，能耗不抵消。",
    expected: "rejected；seed 3、11 产出下降；seed 10 EV 74%", run: async () => {
      const c = await ok<FactoryCriteria>("POST", `${P}/factory-criteria`, { requestId: randomUUID(), projectRevision: 1, criteria: DEFAULT_FACTORY_CRITERIA, rationale: "Frozen before import" });
      const f = await ok<FactoryReview>("POST", `${P}/factory-reviews`, { requestId: randomUUID(), projectRevision: 1, criteriaId: c.id, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id } });
      const s = f.aggregate.failingSeeds;
      return { matched: f.verdict === "rejected" && JSON.stringify(s["output-per-seed"]) === "[3,11]" && JSON.stringify(s["ev-service"]) === "[10]",
        actual: `${f.verdict}；产出 ${s["output-per-seed"].join(",")}；EV ${s["ev-service"].join(",")}；净 +${f.aggregate.netGoodUnitsGain}`, evidence: { reviewId: f.id } };
    } },
  { id: "F2", domain: "工厂维护与能源", title: "显式放宽标准（损失 ≤ 3 件、EV ≥ 70%）", tool: "Robot Reel Factory Twin v0.18.0", rationale: "放宽必须是新冻结版本；旧结论保持拒绝。",
    expected: "accepted-illustrative；新标准摘要不同", run: async () => {
      const c = await ok<FactoryCriteria>("POST", `${P}/factory-criteria`, { requestId: randomUUID(), projectRevision: 1, criteria: { ...DEFAULT_FACTORY_CRITERIA, maxOutputLossPerSeed: 3, minEvServiceRatio: 0.7 }, rationale: "Deliberate relaxation, new version" });
      const f = await ok<FactoryReview>("POST", `${P}/factory-reviews`, { requestId: randomUUID(), projectRevision: 1, criteriaId: c.id, source: { kind: "reviewed-sample", sampleId: REVIEWED_SAMPLE.id } });
      return { matched: f.verdict === "accepted-illustrative", actual: `${f.verdict}；标准 ${c.digest.slice(0, 8)}`, evidence: { reviewId: f.id } };
    } },
  { id: "F3", domain: "数据完整性", title: "篡改上游摘要（seeds.json 与 manifest 一并伪造）", tool: "Factory Twin 一致性校验", rationale: "上游自报结论不能被直接采信；摘要必须能由逐种子结果重算。",
    expected: "422 FACTORY_SUMMARY_INCONSISTENT", run: async () => {
      const seedsText = await readFile(join(config.repository, REVIEWED_SAMPLE.directory, "seeds.json"), "utf8");
      const d = JSON.parse(seedsText); d.summary.good_units_gain.pairs_worse = 0;
      const forged = JSON.stringify(d), manifest = JSON.parse(await readFile(join(config.repository, REVIEWED_SAMPLE.directory, "manifest.json"), "utf8"));
      manifest.files["seeds.json"] = { sha256: sha256(forged), bytes: Buffer.byteLength(forged) };
      const c = await ok<FactoryCriteria>("POST", `${P}/factory-criteria`, { requestId: randomUUID(), projectRevision: 1, criteria: DEFAULT_FACTORY_CRITERIA, rationale: "Integrity check" });
      const r = await call("POST", `${P}/factory-reviews`, { requestId: randomUUID(), projectRevision: 1, criteriaId: c.id,
        source: { kind: "upload", seedsText: forged, manifestText: JSON.stringify(manifest), sourceCommit: REVIEWED_SAMPLE.sourceCommit } });
      return { matched: r.status === 422 && r.body.error === "FACTORY_SUMMARY_INCONSISTENT", actual: `${r.status} ${r.body.error}`, evidence: {} };
    } },
  { id: "A1", domain: "AI 助手", title: "对话放宽壁厚约束", tool: "确定性意图解析 → 类型化计划", rationale: "AI 计划必须标出放宽并保持无验收权，不自动执行。",
    expected: "cad-review 计划；minWallMm 标记为放宽；authority none；未执行", run: async () => {
      const plan = await ok<AssistantPlan>("POST", "/api/assistant/plans", { requestId: randomUUID(), projectId: project.id, message: "NEMA 17 支架壁厚放宽到 2 mm，评估轻量化方案" });
      const step = plan.plans.find(p => p.tool === "cad-review");
      const direction = step?.changes.find(c => c.field === "minWallMm")?.direction;
      return { matched: Boolean(step) && direction === "relaxed" && plan.authority === "none" && plan.confirmations.length === 0,
        actual: `${step?.tool}；minWallMm ${direction}；authority ${plan.authority}；确认 ${plan.confirmations.length}`, evidence: { planId: plan.id, warnings: step?.warnings } };
    } },
];

const results = [];
try {
  for (const c of cases) {
    const started = Date.now();
    process.stderr.write(`${c.id} ${c.title} … `);
    try {
      const r = await c.run();
      results.push({ id: c.id, domain: c.domain, title: c.title, tool: c.tool, rationale: c.rationale, expected: c.expected, actual: r.actual, passed: r.matched, durationMs: Date.now() - started, evidence: r.evidence });
    } catch (error) {
      results.push({ id: c.id, domain: c.domain, title: c.title, tool: c.tool, rationale: c.rationale, expected: c.expected, actual: `ERROR ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`, passed: false, durationMs: Date.now() - started, evidence: {} });
    }
    process.stderr.write(`${results.at(-1)!.passed ? "PASS" : "FAIL"} (${results.at(-1)!.durationMs} ms)\n`);
  }
  const lock = JSON.parse(await readFile(join(config.state, "tools/cadquery-install-receipt.json"), "utf8").catch(() => "{}"));
  const report = { schema: "pai-industrial-suite-1", checkedAt: new Date().toISOString(), result: results.every(r => r.passed) ? "passed" : "failed",
    environment: { node: process.version, blender: "5.2.2 LTS", cadquery: lock.cadquery, ocp: lock.ocp, robotReel: "6124cee3cba5", factoryTwin: REVIEWED_SAMPLE.sourceCommit.slice(0, 12) },
    cases: results, totals: { cases: results.length, passed: results.filter(r => r.passed).length },
    scope: "Recorded simulation, synthetic static geometry, nominal parametric CAD and illustrative factory simulation. No physical validation, FEA, tolerance stack-up or site measurement." };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/industrial-suite.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, totals: report.totals, cases: results.map(r => `${r.id} ${r.passed ? "PASS" : "FAIL"} ${r.actual}`) }, null, 2));
  if (report.result !== "passed") process.exitCode = 1;
} finally { await app.close(); }
