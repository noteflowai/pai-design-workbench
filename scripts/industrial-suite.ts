import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { command } from "../src/adapters.js";
import { createApp } from "../src/server.js";
import { camConfigured, FAMILY_DEFAULTS, DEFAULT_CAD_REQUIREMENTS, DEFAULT_STRUCTURAL, PILLOW_STRUCTURAL, type CadReview } from "../src/cad.js";
import { DEFAULT_FACTORY_CRITERIA, REVIEWED_SAMPLE, type FactoryCriteria, type FactoryReview } from "../src/factory.js";
import { sha256 } from "../src/domain.js";
import type { Project, Review } from "../src/contracts.js";
import { ROBOT_REFERENCE, type SceneReview } from "../src/scenes.js";
import type { AssistantPlan } from "../src/assistant.js";
import type { CadSweep } from "../src/sweep.js";
import type { Release } from "../src/release.js";
import type { Feedback } from "../src/contracts.js";
import { createServer } from "node:net";
import { selectCases, suiteResult } from "./suite-selection.js";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const freePort = () => new Promise<number>(resolve => { const srv = createServer().listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); }); });

/**
 * Representative industrial design test cases across every native lane. Each case states an
 * expectation fixed before execution; "passed" means the native result matched it, not that a
 * design was accepted. Nothing here is physical validation.
 */
const env = configuration();
assert.ok(env.blender && env.cadquery, "Run npm run setup:native and npm run setup:cad first");
const root = join(env.state, "industrial-suite", randomUUID());
const port = await freePort();
// The main suite workbench runs everything locally; remote AgentCore transports are exercised by their own case.
const config = { ...env, port, agentcoreAgentArn: undefined, agentcoreSandboxArn: undefined };
const state = join(root, "main");
const { app } = await createApp({ ...config, state });
await app.listen({ host: "127.0.0.1", port });
const headers = { host: `127.0.0.1:${port}`, "content-type": "application/json" };
const call = async (method: "POST" | "GET" | "PATCH", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers, payload: payload === undefined ? undefined : JSON.stringify(payload) });
  return { status: r.statusCode, body: r.json() };
};
const ok = async <T>(method: "POST" | "GET" | "PATCH", url: string, payload?: unknown) => {
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
const COMPACT_LINE = { stations: 6, stationPitch: 4.5, aisleWidth: 2.4, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 };
const plant = (layout: typeof COMPACT_LINE) => ok<SceneReview>("POST", `${P}/scenes`, { requestId: randomUUID(), projectRevision: 1, variant: "plant", layout,
  requirements: { maxFootprintArea: 650, minAisleWidth: 2.4, minGuardClearance: 0.5, requireCameraCoverage: true, maxEgressTravel: 25 } });
const cad = (variant: string, requirements: typeof DEFAULT_CAD_REQUIREMENTS = DEFAULT_CAD_REQUIREMENTS, parameters?: unknown) =>
  ok<CadReview>("POST", `${P}/cad`, { requestId: randomUUID(), projectRevision: 1, variant, requirements, ...(parameters ? { parameters } : {}) });
const template = await readFile(join(config.repository, "native/cad_template.py"), "utf8");
const generated = (code: string) => ({ requestId: randomUUID(), projectRevision: 1, variant: "generated", requirements: DEFAULT_CAD_REQUIREMENTS, source: { language: "cadquery-2.8", code } });
let sweep: CadSweep | undefined;
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
  { id: "P1", domain: "工厂产线布局（Blender）", title: "6 工位 CNC 线：围栏加大到 4.2 m", tool: "Blender 5.2 BVH 射线 + EvalArc",
    rationale: "为满足机器人安全间距而加大围栏，会挤占相邻的 AGV 通道；这种耦合在参数表里看不出来，需要在生成的几何上实测最窄处。",
    expected: "rejected；仅 aisle-clearance 失败（净宽 < 2.4 m）；围栏间距通过；6/6 相机覆盖；blocking 1", run: async () => {
      const s = await plant({ ...COMPACT_LINE });
      const m = (id: string) => (s.candidate?.checks.find(c => c.id === id) as { observed?: number } | undefined)?.observed;
      return { matched: s.verdict === "rejected" && JSON.stringify(failed(s.candidate)) === '["aisle-clearance"]' && (m("aisle-clearance") ?? 9) < 2.4 && m("camera-coverage") === 6 && s.diff?.blocking_changes === 1,
        actual: `${s.verdict}；失败 ${failed(s.candidate).join(",")}；通道净宽 ${m("aisle-clearance")} m；围栏间距 ${m("guard-clearance")} m；相机 ${m("camera-coverage")}/6；blocking ${s.diff?.blocking_changes}`,
        evidence: { sceneId: s.id, stages: s.stages?.candidate?.length, objects: (s.candidate as { derived?: { objects: number } }).derived?.objects } };
    } },
  { id: "P2", domain: "工厂产线布局（Blender）", title: "不放宽要求：设计通道加宽到 2.8 m", tool: "Blender 5.2 BVH 射线 + EvalArc",
    rationale: "修正必须同时守住占地上限：通道每加宽 0.1 m，厂房增加约 3.9 m²；原生实测确认净宽与占地同时满足。",
    expected: "accepted-static-scene；净宽 ≥ 2.4 m 且占地 ≤ 650 m²", run: async () => {
      const s = await plant({ ...COMPACT_LINE, aisleWidth: 2.8 });
      const m = (id: string) => (s.candidate?.checks.find(c => c.id === id) as { observed?: number } | undefined)?.observed;
      return { matched: s.verdict === "accepted-static-scene" && (m("aisle-clearance") ?? 0) >= 2.4 && (m("footprint-area") ?? 999) <= 650,
        actual: `${s.verdict}；通道净宽 ${m("aisle-clearance")} m；占地 ${m("footprint-area")} m²`, evidence: { sceneId: s.id } };
    } },
  ...(config.physicsPython && config.ccx ? [{ id: "Y1", domain: "结构物理（FEA）", title: "几何最优 t = 3 mm 支架在 60 N 皮带载荷下", tool: "Gmsh C3D10 + CalculiX 2.21 + EvalArc",
    rationale: "只看几何的扫描把 t = 3 mm 选为最轻可行点；加上刚度要求后，必须用求解器判断它是否仍然成立。",
    expected: "rejected；几何 7 项全过，仅 max-deflection 失败；两级网格挠度差 < 5 %", run: async () => {
      const c = await cad("parametric", { ...DEFAULT_CAD_REQUIREMENTS, structural: DEFAULT_STRUCTURAL }, { thickness: 3, width: 60, plateHeight: 46, pilotBore: 22.5 });
      const d = c.candidate?.checks.find(x => x.id === "max-deflection") as { observed?: number } | undefined;
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["max-deflection"]' && (c.fea?.candidate?.convergence.axisDisplacement ?? 1) < 0.05,
        actual: `${c.verdict}；失败 ${failed(c.candidate).join(",")}；挠度 ${d?.observed} mm；收敛 ${c.fea?.candidate?.convergence.axisDisplacement}`, evidence: { cadId: c.id } };
    } },
  { id: "Y2", domain: "结构物理（FEA · 第二零件族）", title: "6202 轴承座底座从 10 mm 减到 6 mm，1 kN 上拔载荷", tool: "Gmsh C3D10 + CalculiX 2.21 + EvalArc",
    rationale: "底座减薄省 29 g，壁厚、边距、H7 孔都不受影响；但轴承孔会随底座弯曲而失圆，挤压外圈，只有求解器能看出来。",
    expected: "rejected；几何 7 项全过，max-deflection 与 bore-distortion 失败，峰值应力远低于许用值", run: async () => {
      const c = await ok<CadReview>("POST", `${P}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", family: "pillow-block",
        requirements: { ...FAMILY_DEFAULTS["pillow-block"], structural: PILLOW_STRUCTURAL },
        parameters: { width: 108, depth: 20, baseDepth: 36, axisHeight: 30, baseThickness: 6, boltPitch: 78, seatDiameter: 35.012, shoulderDiameter: 28 } });
      const v = (id: string) => (c.candidate?.checks.find(x => x.id === id) as { observed?: number } | undefined)?.observed;
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["max-deflection","bore-distortion"]',
        actual: `${c.verdict}；失败 ${failed(c.candidate).join(",")}；轴心 ${(Number(v("max-deflection")) * 1000).toFixed(1)} µm；失圆 ${(Number(v("bore-distortion")) * 1000).toFixed(2)} µm；应力 ${v("max-stress")} MPa`, evidence: { cadId: c.id } };
    } }] as Case[] : []),
  ...(config.physicsPython ? [{ id: "K1", domain: "机器人工作单元（MuJoCo）", title: "提速到 75 % 并把围栏内收到 0.12 m", tool: "MuJoCo 3.14 IK + 动力学 + 接触",
    rationale: "为节拍提速同时压缩占地，机械臂肘部会扫到围栏；只有动力学仿真中的接触检测能发现。",
    expected: "rejected；collision-free 失败；节拍 ≤ 5 s", run: async () => {
      const s = await ok<SceneReview>("POST", `${P}/scenes`, { requestId: randomUUID(), projectRevision: 1, variant: "robot-cell",
        cell: { ...ROBOT_REFERENCE, speedFraction: 0.75, guardClearance: 0.12 }, requirements: { maxCycleSeconds: 5, minSuccessRate: 0.9 } });
      const cyc = s.candidate?.checks.find(x => x.id === "cycle-time") as { observed?: number; passed?: boolean } | undefined;
      return { matched: s.verdict === "rejected" && failed(s.candidate).includes("collision-free") && cyc?.passed === true,
        actual: `${s.verdict}；失败 ${failed(s.candidate).join(",")}；节拍 ${cyc?.observed} s`, evidence: { sceneId: s.id } };
    } }] as Case[] : []),
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
  { id: "C6", domain: "机械零件（CAD · 第二零件族）", title: "6202 轴承座：轴承孔加工成 Ø34.95", tool: "CadQuery 2.8 / OCCT 7.9 + EvalArc",
    rationale: "第二个零件族用同一条评审链：轴承外圈 Ø35 需要 H7（35.000–35.025）孔，过盈的孔装不进轴承也会压坏外圈。",
    expected: "rejected；只有 bearing-seat 失败；blocking 1", run: async () => {
      const c = await cad("pillow-block-tight", FAMILY_DEFAULTS["pillow-block"]);
      const seat = c.candidate!.checks.find(x => x.id === "bearing-seat") as unknown as { observed: { seatDiameter: number } };
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["bearing-seat"]' && c.diff?.blocking_changes === 1,
        actual: `${c.verdict}；轴承孔 Ø${seat.observed.seatDiameter}，H7 下限 35.000；blocking ${c.diff?.blocking_changes}`, evidence: { cadId: c.id } };
    } },
  { id: "D1", domain: "可制造性（DFM / DFA）", title: "紧凑化支架冻结制造要求：M5 安装螺钉能否装上", tool: "CadQuery 2.8 / OCCT 7.9 B-Rep + EvalArc",
    rationale: "底座 M5 孔位置固定，侧加强筋随宽度移动；W = 50 时筋压在孔上方。只看几何和成本会漏掉这种装配问题。",
    expected: "rejected；fastener-access 失败（2 个 M5 孔），单件成本达标", run: async () => {
      const c = await cad("compact", { ...DEFAULT_CAD_REQUIREMENTS, dfm: { maxSetups: 2, maxUnitCostEur: 16 } } as typeof DEFAULT_CAD_REQUIREMENTS);
      const f = c.candidate!.checks.find(x => x.id === "fastener-access") as unknown as { passed: boolean; observed: number };
      const cost = c.candidate!.checks.find(x => x.id === "unit-cost") as unknown as { passed: boolean; observed: number };
      return { matched: c.verdict === "rejected" && !f.passed && f.observed === 2 && cost.passed,
        actual: `${c.verdict}；${f.observed} 个 M5 孔被加强筋压住；成本 ${cost.observed} EUR 达标`, evidence: { cadId: c.id } };
    } },
  ...(camConfigured(config) ? [{ id: "D2", domain: "可制造性（CAM）", title: "基准支架出 G-code 并做独立切削仿真", tool: "FreeCAD 1.1 CAM + OpenCAMLib + 高度图仿真 + EvalArc",
    rationale: "能出程序不等于程序对；刀路要在不依赖 FreeCAD 的仿真里证明不过切、不残料、不撞刀。",
    expected: "accepted；cam-toolpath 通过，2 个装夹程序，节拍 ≤ 120 min", run: async () => {
      const c = await cad("reference", { ...DEFAULT_CAD_REQUIREMENTS, dfm: { maxSetups: 2, maxUnitCostEur: 25, cam: { maxCycleMinutes: 120 } } } as typeof DEFAULT_CAD_REQUIREMENTS);
      const t = c.candidate!.checks.find(x => x.id === "cam-toolpath") as unknown as { passed: boolean };
      const m = c.candidate!.checks.find(x => x.id === "cycle-time") as unknown as { passed: boolean; observed: number };
      const programs = Object.keys(c.files).filter(f => f.startsWith("candidate/setup") && f.endsWith(".nc"));
      return { matched: c.verdict === "accepted-cad-part" && t.passed && m.passed && programs.length === 2,
        actual: `${c.verdict}；${programs.length} 个程序；仿真通过；节拍 ${m.observed} min`, evidence: { cadId: c.id } };
    } } as Case] : []),
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
  // ---------------------------------------------------------------- generated CadQuery code (OS sandbox)
  { id: "G1", domain: "生成代码（沙箱）", title: "AI/工程师写的 CadQuery 代码：板厚 2.5 mm", tool: "AST 策略 + 进程锁定 + bubblewrap → CadQuery / OCCT + EvalArc",
    rationale: "文字生成 CAD 的价值取决于结论不能由生成者自己决定：代码只产出实体，结论来自与预设相同的 B-Rep 检查。",
    expected: "rejected；仅 min-wall 失败（实测 2.5）；沙箱结果 ok；回执含 cadquery-sandbox", run: async () => {
      const c = await ok<CadReview>("POST", `${P}/cad`, generated(template.replace("T = 4.0 ", "T = 2.5 ")));
      const wall = c.candidate?.checks.find(x => x.id === "min-wall")?.observed;
      return { matched: c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["min-wall"]' && wall === 2.5 && c.sandbox?.status === "ok"
          && c.receipts.some(r => r.adapter === "cadquery-sandbox"),
        actual: `${c.verdict}；失败 ${failed(c.candidate).join(",")}；min-wall ${wall} mm；沙箱 ${c.sandbox?.status}`, evidence: { cadId: c.id, codeSha256: c.sandbox?.codeSha256 } };
    } },
  { id: "G2", domain: "生成代码（沙箱）", title: "模板代码与预设基准等价", tool: "沙箱 → 共用 B-Rep 检查",
    rationale: "同一几何经两条路径得到同一组实测值，证明沙箱通道没有另一套“更宽松”的检查。",
    expected: "accepted-cad-part；7 项检查与预设 reference 逐项相同；48.368 g", run: async () => {
      const c = await ok<CadReview>("POST", `${P}/cad`, generated(template));
      const same = JSON.stringify(c.candidate!.checks.map(x => [x.id, x.passed, x.observed])) === JSON.stringify(c.baseline!.checks.map(x => [x.id, x.passed, x.observed]));
      return { matched: c.verdict === "accepted-cad-part" && same && c.candidate!.mass === c.baseline!.mass, actual: `${c.verdict}；逐项相同 ${same}；${c.candidate!.mass} g`, evidence: { cadId: c.id } };
    } },
  { id: "G3", domain: "生成代码（沙箱）", title: "越权代码：导入 os、读 /etc/passwd、取 __globals__", tool: "AST 静态策略",
    rationale: "生成代码可能被注入；越权代码必须在执行前被拒绝，且不留下任何证据记录。",
    expected: "3 次都返回 422 CAD_CODE_POLICY；CAD 记录数不变", run: async () => {
      const before = (await ok<{ cads: unknown[] }>("GET", "/api/state")).cads.length;
      const attacks = [template.replace("import cadquery as cq", "import cadquery as cq\nimport os"), template + "\nx = open('/etc/passwd').read()\n", template + "\nleak = cq.Workplane.__init__.__globals__\n"];
      const codes = [];
      for (const code of attacks) { const r = await call("POST", `${P}/cad`, generated(code)); codes.push(`${r.status} ${r.body.error}`); }
      const after = (await ok<{ cads: unknown[] }>("GET", "/api/state")).cads.length;
      return { matched: codes.every(c => c === "422 CAD_CODE_POLICY") && after === before, actual: `${codes.join("；")}；记录 ${before} → ${after}`, evidence: {} };
    } },
  { id: "G4", domain: "生成代码（沙箱）", title: "资源耗尽：申请 80 GB 内存", tool: "rlimit（地址空间 3 GiB）",
    rationale: "失控代码不能拖垮主机；超限只得到失败记录，没有检查证据，也不自动重试。",
    expected: "failed；沙箱结果 limit；没有候选检查", run: async () => {
      const c = await ok<CadReview>("POST", `${P}/cad`, generated(template + "\nblob = [0] * (10 ** 10)\n"));
      return { matched: c.state === "failed" && c.sandbox?.status === "limit" && !c.candidate, actual: `${c.state}；沙箱 ${c.sandbox?.status}；${c.error?.split(":")[0]}`, evidence: { cadId: c.id } };
    } },
  // ---------------------------------------------------------------- design-space sweep
  { id: "S1", domain: "设计空间探索", title: "支架 24 点原生参数扫描（板厚 × 宽度 × 高度）", tool: "CadQuery / OCCT 逐点 B-Rep 实测",
    rationale: "轻量化的真实问题是“在所有约束下最轻是多少”；逐点原生建模实测，而不是代理模型。",
    expected: "24 点；3 个可行；最轻可行点 t=3、W=60、H=46（37.356 g）；与预设同参数的点逐项一致", run: async () => {
      const sw = await ok<CadSweep>("POST", `${P}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS,
        grid: { thickness: [2.5, 3, 3.5, 4], width: [50, 55, 60], plateHeight: [43.5, 46], pilotBore: [22.5] } });
      sweep = sw;
      const r = sw.result!, light = r.points.find(p => p.index === r.lightestFeasible)!;
      const ref = r.points.find(p => p.parameters.thickness === 4 && p.parameters.width === 60 && p.parameters.plateHeight === 46)!;
      const light2 = r.points.find(p => p.parameters.thickness === 2.5 && p.parameters.width === 60 && p.parameters.plateHeight === 46)!;
      return { matched: sw.state === "completed" && r.points.length === 24 && r.feasibleCount === 3 && light.parameters.thickness === 3 && light.parameters.width === 60
          && light.parameters.plateHeight === 46 && light.mass === 37.356 && ref.mass === 48.368 && JSON.stringify(light2.failed) === '["min-wall"]',
        actual: `${r.points.length} 点；可行 ${r.feasibleCount}；最轻 t=${light.parameters.thickness} W=${light.parameters.width} H=${light.parameters.plateHeight} ${light.mass} g；前沿 ${sw.pareto?.join(",")}`,
        evidence: { sweepId: sw.id, pareto: sw.pareto } };
    } },
  { id: "S2", domain: "设计空间探索", title: "扫描点转为正式候选；伪造来源被拒绝", tool: "参数化配方 + EvalArc",
    rationale: "扫描只排序不验收：选中的点必须作为普通候选重新原生评审，且来源必须真实。",
    expected: "accepted-cad-part；质量与扫描点相同；EvalArc 0 阻断；伪造参数返回 422 INVALID_SWEEP_POINT", run: async () => {
      const light = sweep!.result!.points.find(p => p.index === sweep!.result!.lightestFeasible)!;
      const c = await ok<CadReview>("POST", `${P}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", requirements: DEFAULT_CAD_REQUIREMENTS,
        parameters: light.parameters, fromSweep: { sweepId: sweep!.id, point: light.index } });
      const forged = await call("POST", `${P}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", requirements: DEFAULT_CAD_REQUIREMENTS,
        parameters: { ...light.parameters, thickness: 2.5 }, fromSweep: { sweepId: sweep!.id, point: light.index } });
      return { matched: c.verdict === "accepted-cad-part" && c.candidate!.mass === light.mass && c.diff?.blocking_changes === 0 && forged.status === 422 && forged.body.error === "INVALID_SWEEP_POINT",
        actual: `${c.verdict}；${c.candidate!.mass} g；blocking ${c.diff?.blocking_changes}；伪造 ${forged.status} ${forged.body.error}`, evidence: { cadId: c.id } };
    } },
  // ---------------------------------------------------------------- full lifecycle to release
  { id: "L1", domain: "生命周期闭环", title: "失败 → 反馈复测关闭 → 扫描选型 → 发布准入 → 批准 → 需求修订后废止", tool: "全部 CAD 通道 + 发布准入",
    rationale: "工业交付要求每个失败都有处置、发布绑定当前需求，需求变化后旧发布自动失效。",
    expected: "未关闭失败时准入不通过；关闭后通过；R1 批准为 released；需求 v2 后 superseded", run: async () => {
      const lp = await ok<Project>("POST", "/api/projects", { title: "Bracket release", intendedDecision: "Release the lightest bracket that keeps every check",
        requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
      const LP = `/api/projects/${lp.id}`;
      const light = await ok<CadReview>("POST", `${LP}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "lightweight", requirements: DEFAULT_CAD_REQUIREMENTS });
      const sw = await ok<CadSweep>("POST", `${LP}/cad-sweeps`, { requestId: randomUUID(), projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS,
        grid: { thickness: [3], width: [60], plateHeight: [46], pilotBore: [22.5] } });
      const pick = await ok<CadReview>("POST", `${LP}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", requirements: DEFAULT_CAD_REQUIREMENTS,
        parameters: sw.result!.points[0].parameters, fromSweep: { sweepId: sw.id, point: 1 } });
      const admission = async () => ok<{ id: string; passed: boolean }[]>("GET", `${LP}/admission?kind=cad-part&runId=${pick.id}`);
      const blocked = (await admission()).filter(c => !c.passed).map(c => c.id);
      let f = await ok<Feedback>("POST", "/api/feedback", { runId: light.id, evidenceKind: "cad-part", kind: "design-check", checkId: "min-wall", seed: null,
        expected: "Plates at least 3 mm", observed: "Lightweight variant has 2.5 mm plates", actorKind: "maintainer" });
      for (const status of ["reproducible", "assigned", "fix-proposed"]) f = await ok<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status, reason: "Restore 4 mm plates, same requirements" });
      const re = await ok<CadReview>("POST", `${LP}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "reference", requirements: DEFAULT_CAD_REQUIREMENTS, feedbackId: f.id });
      f = await ok<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason: "Recheck passes min-wall", recheckRunId: re.id });
      f = await ok<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "Closed; nominal geometry only" });
      const open = (await admission()).filter(c => !c.passed).map(c => c.id);
      let rel = await ok<Release>("POST", `${LP}/releases`, { requestId: randomUUID(), projectRevision: 1, evidenceKind: "cad-part", runId: pick.id, title: "NEMA 17 bracket t=3 mm", notes: "Sweep-selected" });
      rel = await ok<Release>("PATCH", `${LP}/releases/${rel.id}`, { expectedRevision: rel.revision, decision: "approve", reason: "All admission checks pass" });
      await ok("PATCH", LP, { title: lp.title, intendedDecision: lp.intendedDecision, expectedRevision: 1,
        requirements: { minSuccessRate: 0.6, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
      const after = (await ok<{ releases: Release[] }>("GET", "/api/state")).releases.find(r => r.id === rel.id)!;
      return { matched: blocked.includes("failures-dispositioned") && open.length === 0 && rel.maturity === "released" && after.maturity === "superseded" && pick.verdict === "accepted-cad-part",
        actual: `关闭前未通过 ${blocked.join(",")}；关闭后未通过 ${open.length} 项；${rel.number} ${rel.maturity} → 需求 v2 后 ${after.maturity}`, evidence: { projectId: lp.id, releaseId: rel.id } };
    } },
  // ---------------------------------------------------------------- AI planner and external agents
  { id: "A2", domain: "AI 助手", title: "模型计划：写 cad-code 并夹带越权工具", tool: "执行器（固定回放）→ 契约校验 → 确认后沙箱执行",
    rationale: "模型输出是不可信的：越权工具被丢弃，合法计划必须经核对门槛与人工确认才执行，结论仍由原生检查给出。",
    expected: "1 个 cad-code 计划；approve-release 被拒绝；确认前无记录；确认后 accepted（min-wall 3.5）", run: async () => {
      const fake = join(config.repository, "tests/fixtures/fake-executor.mjs");
      const dir = join(root, "ai"), ledger = join(dir, "ledger.sqlite3");
      await mkdir(dir, { recursive: true, mode: 0o700 }); await writeFile(ledger, "");
      const aiConfig = { ...config, state: dir, controllerEntrypoint: fake, controllerDatabase: ledger, controlRoot: dirname(fake), port: await freePort() };
      const ai = await createApp(aiConfig);
      try {
        const h = { host: `127.0.0.1:${aiConfig.port}`, "content-type": "application/json" };
        const inj = async <T>(method: "POST" | "GET", url: string, payload?: unknown) => { const r = await ai.app.inject({ method, url, headers: h, payload: payload === undefined ? undefined : JSON.stringify(payload) }); assert.equal(r.statusCode, 200, r.body); return r.json() as T; };
        const p = await inj<Project>("POST", "/api/projects", { title: "AI bracket", intendedDecision: "Model-written geometry only through native checks",
          requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
        process.env.FAKE_EXECUTOR = JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({ kind: "plan", plans: [
          { ref: "p1", tool: "cad-code", title: "3.5 mm 板厚", payload: { code: template.replace("T = 4.0 ", "T = 3.5 ") } },
          { ref: "p2", tool: "approve-release", payload: {} }] }) + "\n```" }] });
        const plan = await inj<AssistantPlan>("POST", "/api/assistant/ai", { requestId: randomUUID(), projectId: p.id, message: "写一个板厚 3.5 mm 的支架" });
        const before = (await inj<{ cads: unknown[] }>("GET", "/api/state")).cads.length;
        const step = plan.plans[0];
        await inj("POST", `/api/assistant/plans/${plan.id}/preflight`, { planId: step.id });
        const c = await inj<CadReview>("POST", `/api/projects/${p.id}/cad`, { ...step.payload, requestId: randomUUID() });
        const conf = await inj<AssistantPlan>("POST", `/api/assistant/plans/${plan.id}/confirmations`, { planId: step.id, recordKind: "cad-review", recordId: c.id });
        const rejected = plan.interpretation.some(x => /已拒绝 AI 计划 p2（approve-release）/.test(x));
        const wall = c.candidate?.checks.find(x => x.id === "min-wall")?.observed;
        return { matched: plan.state === "done" && plan.plans.length === 1 && step.tool === "cad-code" && rejected && before === 0 && c.verdict === "accepted-cad-part" && wall === 3.5 && conf.confirmations[0].match === "as-proposed",
          actual: `${plan.state}；计划 ${plan.plans.map(x => x.tool).join(",")}；越权被拒 ${rejected}；确认前记录 ${before}；${c.verdict} min-wall ${wall}`, evidence: { planId: plan.id, cadId: c.id } };
      } finally { delete process.env.FAKE_EXECUTOR; await ai.app.close(); }
    } },
  { id: "M1", domain: "外部 Agent（MCP）", title: "外部 Agent 读证据、自查代码、提议计划", tool: "stdio MCP（官方 SDK）",
    rationale: "企业里的 AI 客户端各不相同；开放读取与提议，但不开放执行、验收与发布。",
    expected: "11 个工具（含求解数据集、授权内执行），无执行/发布类；代码自查发现 import os；提议后未执行；确认后可读到确认状态", run: async () => {
      const client = new Client({ name: "Suite Agent", version: "1.0.0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", join(config.repository, "src/mcp.ts")],
        env: { PATH: process.env.PATH ?? "", PAI_URL: `http://127.0.0.1:${port}` }, stderr: "pipe", cwd: config.repository }));
      try {
        const tool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text);
        const names = (await client.listTools()).tools.map(t => t.name);
        const check = await tool("pai_check_cad_code", { code: template.replace("import cadquery as cq", "import cadquery as cq\nimport os") });
        const prop = await tool("pai_propose_plan", { projectId: project.id, intent: "评估紧凑化方案", plans: [{ ref: "p1", tool: "cad-review", title: "紧凑化", payload: { variant: "compact" } }] });
        const pending = await tool("pai_get_plan", { planId: prop.planId });
        const plan = await ok<AssistantPlan>("GET", `/api/assistant/plans/${prop.planId}`);
        const c = await ok<CadReview>("POST", `${P}/cad`, { ...plan.plans[0].payload, requestId: randomUUID() });
        await ok("POST", `/api/assistant/plans/${prop.planId}/confirmations`, { planId: "p1", recordKind: "cad-review", recordId: c.id });
        const done = await tool("pai_get_plan", { planId: prop.planId });
        const forbidden = names.filter(n => /approve|release|confirm|execute|feedback|reconcil/.test(n));
        return { matched: names.length === 11 && names.includes("pai_get_solver_dataset") && names.includes("pai_run_plan") && forbidden.length === 0 && check.ok === false && check.violations.some((v: string) => v.includes("os")) && prop.authority === "none"
            && pending.steps[0].confirmed === null && done.steps[0].confirmed?.match === "as-proposed" && c.verdict === "rejected",
          actual: `${names.length} 个工具；禁用类 ${forbidden.length}；自查违规 ${check.violations.length}；确认前 ${pending.steps[0].confirmed}；确认后 ${done.steps[0].confirmed?.match}；${c.verdict}`, evidence: { planId: prop.planId } };
      } finally { await client.close(); }
    } },
  // Real model (spends one attempt on the reviewed ledger); opt-in so CI never calls an engine.
  ...(process.env.PAI_SUITE_LIVE_AI === "1" && config.controllerEntrypoint && config.controllerDatabase ? [{ id: "A3", domain: "AI 助手", title: "真实模型：根据失败证据写修正代码",
    tool: "受控执行器（Kiro 主→备→二备）→ 契约校验 → 沙箱", rationale: "端到端检验真实模型：答案引用已存记录，计划经确认后由原生检查决定结论。",
    expected: "done；引用存在的记录；至少 1 个 cad-code 计划；确认执行后 min-wall 通过", run: async () => {
      const plan = await ok<AssistantPlan>("POST", "/api/assistant/ai", { requestId: randomUUID(), projectId: project.id,
        message: "最近一次生成代码的支架板厚 2.5 mm 没有通过最小壁厚。请用 cad-code 工具从模板出发写一份 CadQuery 代码，只把板厚改为 3.5 mm，其余不变，并说明依据。" });
      const step = plan.plans.find(p => p.tool === "cad-code");
      if (plan.state !== "done" || !step) return { matched: false, actual: `${plan.state}；计划 ${plan.plans.map(p => p.tool).join(",")}；${plan.interpretation.join(" | ").slice(0, 200)}`, evidence: { planId: plan.id } };
      await ok("POST", `/api/assistant/plans/${plan.id}/preflight`, { planId: step.id });
      const c = await ok<CadReview>("POST", `${P}/cad`, { ...step.payload, requestId: randomUUID() });
      await ok("POST", `/api/assistant/plans/${plan.id}/confirmations`, { planId: step.id, recordKind: "cad-review", recordId: c.id });
      const minWall = c.candidate?.checks.find(x => x.id === "min-wall");
      return { matched: c.state === "completed" && minWall?.passed === true,
        actual: `${plan.state}；${plan.ai?.engine?.profile} ${plan.ai?.engine?.model}；引用 ${plan.answer?.citations.map(x => x.handle).join(",") ?? "无"}；${c.verdict}；min-wall ${minWall?.observed}`,
        evidence: { planId: plan.id, cadId: c.id, attempts: plan.ai?.attempts.map(a => `${a.profile}:${a.errorKind ?? a.status}`) } };
    } } as Case] : []),
  ...(env.agentcoreSandboxArn ? [{ id: "X1", domain: "云端沙箱（AgentCore arm64）", title: "生成代码在 Amazon Bedrock AgentCore microVM 中建模", tool: "AgentCore Runtime（BYOC arm64）",
    rationale: "把不可信代码放到每任务独立、无网络路由、无凭据的 microVM；结论与本地沙箱相同。",
    expected: "rejected；仅 min-wall（2.5）；transport agentcore；microVM 与 bubblewrap 均启用", run: async () => {
      const xPort = await freePort();
      const remote = await createApp({ ...config, state: join(root, "agentcore"), agentcoreSandboxArn: env.agentcoreSandboxArn, port: xPort });
      try {
        const h = { host: `127.0.0.1:${xPort}`, "content-type": "application/json" };
        const inj = async <T>(method: "POST" | "GET", url: string, payload?: unknown) => { const r = await remote.app.inject({ method, url, headers: h, payload: payload === undefined ? undefined : JSON.stringify(payload) }); assert.equal(r.statusCode, 200, r.body); return r.json() as T; };
        const caps = (await inj<{ capabilities: { cad: { generatedCode: { transport: string; available: boolean; remote?: { arch: string } } } } }>("GET", "/api/state")).capabilities.cad.generatedCode;
        const p = await inj<Project>("POST", "/api/projects", { title: "AgentCore sandbox", intendedDecision: "Untrusted code in an isolated microVM",
          requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
        const c = await inj<CadReview>("POST", `/api/projects/${p.id}/cad`, generated(template.replace("T = 4.0 ", "T = 2.5 ")));
        const wall = c.candidate?.checks.find(x => x.id === "min-wall")?.observed;
        return { matched: caps.available && caps.transport === "agentcore" && c.verdict === "rejected" && JSON.stringify(failed(c.candidate)) === '["min-wall"]' && wall === 2.5
            && c.sandbox?.transport === "agentcore" && c.sandbox?.layers?.microvm === true && c.sandbox?.layers?.bubblewrap === true,
          actual: `${c.verdict}；失败 ${failed(c.candidate).join(",")}；min-wall ${wall}；${c.sandbox?.transport} ${caps.remote?.arch}；层 ${Object.entries(c.sandbox?.layers ?? {}).filter(([, v]) => v).map(([k]) => k).join("+")}`,
          evidence: { cadId: c.id, adapters: c.receipts.map(r => r.adapter) } };
      } finally { await remote.app.close(); }
    } } as Case] : []),
];

const results = [];
try {
  // Selection is checked before any case runs; unknown ids and an empty selection fail (scripts/suite-selection.ts).
  const { selected, selection } = selectCases(cases, process.env);
  for (const c of selected) {
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
  const report = { schema: "pai-industrial-suite-1", checkedAt: new Date().toISOString(), result: suiteResult(results),
    environment: { node: process.version, blender: "5.2.2 LTS", cadquery: lock.cadquery, ocp: lock.ocp, robotReel: "6124cee3cba5", factoryTwin: REVIEWED_SAMPLE.sourceCommit.slice(0, 12) },
    selection,
    cases: results, totals: { cases: results.length, passed: results.filter(r => r.passed).length },
    scope: "Recorded simulation, synthetic static geometry, nominal parametric CAD, linear static FEA, RANS CFD, CAM simulation and illustrative factory simulation. No physical validation, certification-grade FEA, tolerance stack-up or site measurement." };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/industrial-suite.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, totals: report.totals, cases: results.map(r => `${r.id} ${r.passed ? "PASS" : "FAIL"} ${r.actual}`) }, null, 2));
  if (report.result !== "passed") process.exitCode = 1;
} finally { await app.close(); }
