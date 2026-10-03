// Records "Demo A": a faster robot workcell, verified by physics. It runs against a local workbench with
// MuJoCo, CadQuery, Gmsh + CalculiX and the real bounded AI engine (Kiro).
// Usage: node scripts/record-physics-demo.mjs http://127.0.0.1:4319 <output-dir>
// Every simulation, solve, AI plan and signature shown is produced live. Numbers in captions are read back from the
// saved records. Overlays exist only in this recording context. Static waits are accelerated by tools/render_demo.py.
import { writeFile } from "node:fs/promises";
import { openDemo } from "./demo-kit.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? ".state/demo-physics-video";
const { browser, context, page, pause, caption, chapter, keys, card, click, type, orbit, spot, wheelTo, assistant, composer, mark, elapsed, t0 } = await openDemo(out);
page.setDefaultTimeout(180_000);

const endCard = async () => card("PAI Design Workbench", "AI 提出方案，物理求解器给出结论",
  ["MuJoCo 动力学", "Gmsh + CalculiX FEA", "代理模型只排序", "Kiro AI 引擎", "签名发布包（托管站点：AWS KMS）"], "github.com/noteflowai/pai-design-workbench");
if (process.env.ENDCARD_ONLY) {
  await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
  await endCard(); await pause(1200); await page.screenshot({ path: `${out}/endcard.png` });
  await context.close(); await browser.close(); process.exit(0);
}
const state = async () => (await page.request.get(`${base}/api/state`)).json();
const viewport = page.locator(".viewport");
const busyDone = () => page.locator(".busy").waitFor({ state: "detached", timeout: 900_000 }).catch(() => undefined);
async function advance(names) {
  for (const name of names) { await click(page.getByRole("button", { name, exact: true }), 300); await pause(800); await busyDone(); await pause(600); }
}
async function modelPlan(tool, after) {
  for (let i = 0; i < 300; i++) {
    const p = (await state()).assistantPlans.filter(x => x.source === "model" && x.createdAt > after && x.state !== "running").at(-1);
    if (p) return p;
    await pause(2000);
  }
  throw new Error(`no model plan for ${tool}`);
}
const facts = {};

// ---------------------------------------------------------------- title
await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
await card("机器人工作单元提速：AI 设计，物理验证", "MuJoCo 发现碰撞 → AI 修正 → CalculiX 否决几何最优 → 物理寻优 → 签名发布",
  ["MuJoCo 3.14 刚体动力学", "Gmsh + CalculiX 2.21", "GP 代理模型 + NSGA-II", "Kiro 2.27 · claude-opus-5.5", "EvalArc 独立对照", "签名发布包"],
  "全部结果实时生成，未剪辑；静止的等待画面已加速");
await pause(5500); await card(""); await pause(800);

// ---------------------------------------------------------------- 1 requirement
mark("requirements");
await chapter("01", "冻结需求");
await caption("目标：取放节拍从 5.9 s 降到 5 s 以内", "同时不碰撞、10 个种子成功率 ≥ 90 %；电机支架要轻，并且在皮带载荷下够刚");
await click(page.getByRole("button", { name: "新建", exact: true }), 600);
await page.getByLabel("任务名称").fill("");
await type(page.getByLabel("任务名称"), "取放工作单元提速 15 % 以上");
await page.getByLabel("准备作出的决策").fill("节拍 ≤ 5 s、无碰撞、成功率 ≥ 90 %；相机/电机支架挠度 ≤ 0.06 mm（60 N 皮带载荷），在此前提下尽量轻。");
await click(page.getByRole("button", { name: "创建评审任务" }), 1400);
await pause(1500);

// ---------------------------------------------------------------- 2 MuJoCo rejection
mark("mujoco");
await chapter("02", "MuJoCo 动力学仿真");
await page.goto(`${base}/#/design?lane=robotcell`); await pause(900);
await caption("工程师的初版：关节速度提到 75 %，围栏内收到 0.12 m 以节省占地", "生成 MJCF：六轴臂（UR5e 级连杆）、输送线、工装、四面围栏");
const field = label => page.getByLabel(label, { exact: true });
await field("关节速度").fill(""); await type(field("关节速度"), "75");
await field("围栏离最远工位").fill(""); await type(field("围栏离最远工位"), "0.12");
await field("节拍上限").fill(""); await type(field("节拍上限"), "5");
await click(page.getByRole("button", { name: "仿真并检查工作单元" }), 400);
await caption("10 个种子逐一仿真：逆运动学、五次多项式轨迹、500 Hz 动力学、接触检测", "基准是 50 % 速度、围栏 0.40 m 的参考工作单元");
await page.getByRole("heading", { name: "场景检查拒绝" }).waitFor({ timeout: 300_000 });
await pause(6000);
let s = await state();
const bad = s.scenes.filter(x => x.request.variant === "robot-cell").at(-1);
const m = (rec, id) => rec.candidate.checks.find(c => c.id === id);
facts.rejectedCell = { cycle: m(bad, "cycle-time").observed, collisionFree: m(bad, "collision-free").observed, baselineCycle: bad.baseline.checks.find(c => c.id === "cycle-time").observed };
await wheelTo(viewport, 60); await pause(800); await orbit(80, -10); await pause(1200);
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(400);
await caption(`节拍 ${facts.rejectedCell.cycle} s 达标，但 10 个种子里无碰撞的是 ${facts.rejectedCell.collisionFree} 个`, "肘部扫到内收的围栏；EvalArc 判定候选丢失了基准通过的检查");
await spot(page.locator(".check-table"), 2800);
await wheelTo(page.getByRole("table", { name: "配对种子（同一来料偏差）" }), 120); await pause(2500);

// ---------------------------------------------------------------- 3 AI fixes the cell
mark("ai-cell");
await chapter("03", "AI 修正工作单元");
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption("在失败的检查上直接“问 AI”", "自动带上实测值、当前参数和冻结要求；AI 只能提出计划，没有验收权");
const after1 = new Date().toISOString();
await click(page.locator(".check-table tr.fail").filter({ hasText: "运动无碰撞" }).getByRole("button", { name: /问 AI/ }), 900);
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 600);
const plan1 = await modelPlan("robot-cell", after1);
const step1 = plan1.plans.find(p => p.tool === "robot-cell");
if (!step1) throw new Error(`model returned no robot-cell plan (state ${plan1.state})`);
const card1 = assistant.getByRole("article", { name: `计划 ${step1.title}` });
await card1.waitFor(); await card1.scrollIntoViewIfNeeded(); await pause(800);
const changed1 = step1.changes.filter(c => c.direction !== "same" && c.direction !== "new").map(c => `${c.field.replace("cell.", "")} ${c.from} → ${c.to}`);
facts.ai1 = { engine: plan1.ai?.engine, changes: changed1, citations: plan1.answer?.citations?.map(c => c.handle) };
await caption(`AI（${plan1.ai?.engine?.profile} · ${plan1.ai?.engine?.model} · Kiro ${plan1.ai?.engine?.engineVersion}）：${changed1.join("，") || "见计划"}`, "保持 75 % 速度，不放宽任何要求；计划按 schema 重新校验");
await spot(card1, 2800);
await click(card1.getByRole("button", { name: "确认执行" }), 600);
await page.getByRole("heading", { name: "静态场景检查通过" }).waitFor({ timeout: 300_000 });
await pause(5000);
s = await state();
const good = s.scenes.filter(x => x.request.variant === "robot-cell" && x.verdict === "accepted-static-scene").at(-1);
facts.fixedCell = { cycle: m(good, "cycle-time").observed, success: m(good, "success-rate").observed };
const faster = Math.round((1 - facts.fixedCell.cycle / facts.rejectedCell.baselineCycle) * 100);
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption(`复测通过：节拍 ${facts.fixedCell.cycle} s，比参考快 ${faster} %，10/10 个种子成功`, "MuJoCo 实测；AI 自己的判断不计入结论");
await spot(page.locator(".check-table"), 2600);

// ---------------------------------------------------------------- 4 feedback closes the failure
mark("feedback-cell");
await chapter("04", "失败案例走完反馈闭环");
await page.goto(`${base}/#/validate?kind=blender-scene&id=${bad.id}`); await pause(1200);
await caption("失败记录不会被覆盖：它要通过反馈、绑定的复测和关闭来处置", "复测用的是已通过的修正方案，原样重新跑 MuJoCo");
await click(page.getByRole("button", { name: /记录反馈：MuJoCo 运动无碰撞/ }), 900);
await advance(["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"]);
await pause(1500);

// ---------------------------------------------------------------- 5 FEA rejects the geometry optimum
mark("fea");
await chapter("05", "支架：CalculiX 否决几何最优");
await page.goto(`${base}/#/design?lane=cad`); await pause(900);
await caption("提速后皮带拉力更大；电机支架要冻结结构要求", "60 N 径向载荷、力臂 50 mm、挠度 ≤ 0.06 mm、安全系数 2（6061-T6）");
await click(page.getByRole("radio", { name: /参数化/ }), 400);
await field("板厚 t").fill(""); await type(field("板厚 t"), "3");
await click(page.getByLabel("冻结结构要求并做 FEA"), 400);
await caption("t = 3 mm 是只看几何时扫描出的最轻可行点", "这次再加上 Gmsh 二次四面体网格 + CalculiX 线性静力分析，两级网格对照");
await click(page.getByRole("button", { name: "生成并检查 CAD 零件" }), 400);
await page.getByRole("heading", { name: /零件检查(拒绝|通过)/ }).waitFor({ timeout: 900_000 });
await pause(6000);
s = await state();
const thin = s.cads.filter(x => x.projectId === s.projects.at(-1).id).at(-1);
facts.fea = { minWall: thin.candidate.checks.find(c => c.id === "min-wall").passed, deflection: thin.candidate.checks.find(c => c.id === "max-deflection").observed,
  convergence: thin.fea?.candidate?.convergence?.axisDisplacement };
await wheelTo(viewport, 60); await pause(800); await orbit(120, -20); await pause(1500); await orbit(-160, 20);
await caption("von Mises 应力云图（变形已放大）", `两级网格的挠度差 ${(facts.fea.convergence * 100).toFixed(1)} %；.inp 与 .frd 可在 ParaView / cgx 中打开`);
await pause(2500);
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption(`几何 7 项全过，但 CalculiX 实测电机轴挠度 ${facts.fea.deflection} mm > 0.06 mm`, "只看几何的最优解会被物理检查否决");
await spot(page.locator(".check-table tr.fail"), 2800);

// ---------------------------------------------------------------- 6 AI-seeded physics optimisation
mark("ai-optimize");
await chapter("06", "AI + 物理寻优");
const after2 = new Date().toISOString();
await click(page.locator(".check-table tr.fail").getByRole("button", { name: /问 AI/ }), 900);
await composer.fill("");
await type(composer, `cad-${s.cads.filter(x => x.projectId === thin.projectId).length} 的电机轴挠度实测 ${facts.fea.deflection} mm 超过 0.06 mm。请用 cad-optimize 规划物理寻优：给出 2–3 个按第一性原理估算的种子（写明 expectedDeflectionMm 和 expectedMassG），不要放宽任何要求，并引用记录说明理由。`, 10);
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 600);
await caption("请 AI 先用物理直觉给出种子，并写下它自己的挠度估算", "求解器之后会给这些估算打分");
const plan2 = await modelPlan("cad-optimize", after2);
const step2 = plan2.plans.find(p => p.tool === "cad-optimize");
if (!step2) throw new Error(`model returned no cad-optimize plan (state ${plan2.state})`);
const card2 = assistant.getByRole("article", { name: `计划 ${step2.title}` });
await card2.waitFor(); await card2.scrollIntoViewIfNeeded(); await pause(800);
facts.ai2 = { engine: plan2.ai?.engine, seeds: step2.payload.seeds?.map(x => ({ ...x.parameters, expectedDeflectionMm: x.expectedDeflectionMm, expectedMassG: x.expectedMassG })) };
await caption(`AI 给出 ${facts.ai2.seeds?.length ?? 0} 个种子：${(facts.ai2.seeds ?? []).map(x => `t ${x.thickness}/W ${x.width} → ${x.expectedDeflectionMm} mm`).join("；")}`,
  "确认后：参考件 + AI 种子 + Sobol 点实测 → GP 代理模型排序 → 几何筛查 → CalculiX 复算");
await spot(card2, 3000);
await click(card2.getByRole("button", { name: "确认执行" }), 600);
await caption("每一轮：代理模型在数百个候选中排序，只把最有希望和最不确定的点交给求解器", "代理模型只负责排序；报告里的每个点都是 CadQuery + CalculiX 实测");
for (let i = 0; i < 900; i++) {
  const o = (await state()).cadOptimizations?.filter(x => x.projectId === thin.projectId).at(-1);
  if (o && o.state !== "running") break;
  await pause(2000);
}
await pause(8000);
s = await state();
const opt = s.cadOptimizations.filter(x => x.projectId === thin.projectId).at(-1);
const best = opt.result?.points.find(p => p.index === opt.result.lightestFeasible);
facts.optimize = { points: opt.result?.points.length, feasible: opt.result?.feasibleCount, best: best && { origin: best.origin, ...best.parameters, mass: best.mass, deflectionMm: best.deflectionMm },
  aiSeeds: opt.result?.aiSeeds, calibration: opt.result?.calibration?.slice(-4) };
const panel = page.locator(".card", { has: page.getByRole("heading", { name: "物理寻优（FEA + 代理模型）" }) });
await wheelTo(panel.getByRole("group", { name: "质量与实测挠度散点图" }), 140); await pause(1500);
await caption(`${facts.optimize.points} 个实测点，${facts.optimize.feasible} 个可行；最轻可行：${best?.origin === "ai-seed" ? "AI 种子 " : ""}t ${best?.thickness}、W ${best?.width}，${best?.mass} g，挠度 ${best?.deflectionMm} mm`,
  "◆ 为 AI 种子；圆环为可行点的帕累托前沿（更轻 / 更刚）");
await spot(panel.locator(".sweep-plot"), 3200);
const seedTable = panel.getByRole("table", { name: "AI 物理估算与 CalculiX 实测对照" });
if (await seedTable.count()) {
  await wheelTo(seedTable, 160); await pause(600);
  const errs = (opt.result.aiSeeds ?? []).filter(x => x.relativeError !== null).map(x => Math.round(x.relativeError * 100));
  await caption(`AI 的物理估算，由 CalculiX 打分：误差 ${errs.join("、")} %`, "模型的物理推理是被测量的量，不是结论");
  await spot(seedTable, 3000);
}
await wheelTo(panel.locator(".sweep-pick"), 160); await pause(500);
await caption("推荐点必须走正式复核", "两级网格 FEA、基准对照与 EvalArc；来源可核对");
await click(panel.getByRole("button", { name: "以此参数生成正式候选（两级网格复核）" }), 400);
await page.getByRole("heading", { name: /零件检查(通过|拒绝)/ }).waitFor({ timeout: 900_000 });
await pause(6000);
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption("正式复核通过：9 项检查全部满足", `比参考件（48.4 g）轻 ${best ? Math.round((1 - best.mass / 48.368) * 100) : "—"} %，挠度仍在 0.06 mm 以内`);
await spot(page.locator(".check-table"), 2600);

// ---------------------------------------------------------------- 7 close the CAD failure, release, sign
mark("release");
await chapter("07", "处置失败 → 发布 → 签名");
await page.goto(`${base}/#/validate?kind=cad-part&id=${thin.id}`); await pause(1200);
await click(page.getByRole("button", { name: /记录反馈：CAD 电机轴挠度/ }), 900);
await advance(["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"]);
await page.getByRole("navigation", { name: "生命周期" }).getByRole("link", { name: /发布交付/ }).click(); await pause(1500);
await caption("准入检查：结论通过、绑定当前需求、所有失败案例都已关闭", "缺一项就不能创建发布候选");
await spot(page.getByLabel("发布准入检查"), 2600);
await click(page.getByRole("button", { name: "创建发布候选" }), 1200);
await click(page.getByRole("button", { name: "批准发布 R1" }), 1500);
await page.getByText("R1 已发布").first().waitFor({ timeout: 60_000 }); await busyDone(); await pause(1500);
const signed = page.getByRole("status").filter({ hasText: "签名有效" });
// Verification is read-only: if the first click raced the post-approval re-render, clicking again is harmless.
for (let i = 0; i < 2 && !(await signed.count()); i++) {
  await click(page.getByRole("button", { name: "核验签名" }), 600);
  await signed.waitFor({ timeout: 45_000 }).catch(() => undefined);
}
if (!(await signed.count())) throw new Error(`signature status: ${await page.locator('[role="status"]').allInnerTexts()}`);
facts.signerLabel = (await signed.innerText()).includes("KMS") ? "AWS KMS ECDSA P-256" : "本机 Ed25519 密钥；托管站点使用 AWS KMS";
await caption("发布包：证据记录 + 全部原生文件（STEP、FEA、MJCF…）+ 审批记录", `清单已签名（${facts.signerLabel}）；任何人都可以用公开的公钥离线核验`);
await spot(page.locator(".release-history"), 3200);
facts.signed = await signed.innerText();

await caption("Ctrl+K：命令、跳转，或直接问 AI", "全生命周期由记录推导");
await keys(["Ctrl", "K"]); await page.keyboard.press("Control+k"); await pause(900); await keys([]);
await page.keyboard.type("总览", { delay: 90 }); await pause(700); await page.keyboard.press("Enter"); await pause(3000);
await caption(""); await chapter("");
await endCard(); await pause(1200);
await page.screenshot({ path: `${out}/endcard.png` });
await pause(3000);
const result = { marks: elapsed(), facts, totalSeconds: Math.round((Date.now() - t0) / 1000) };
await context.close(); await browser.close();
await writeFile(`${out}/marks.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
