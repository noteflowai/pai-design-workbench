// Records "Demo E": the AI designs a 6202 pillow-block housing under a maintainer's grant, and the native solvers
// decide. A compact housing fails the bolt edge rule; the maintainer issues a grant and a goal; a real model (through
// the bounded executor and the shared ledger) proposes a parametric fix; the executor cannot verify the engine's
// effects, so a person records why it is safe and the step runs under the grant; CadQuery/OCCT decides. Then the
// bearing load is frozen and CalculiX-backed optimisation finds the lightest housing that keeps the seat round; the
// formal two-mesh review, the AI track record, feedback closure and the signed release follow.
// Usage: node scripts/record-ai-demo.mjs http://127.0.0.1:4319 <output-dir>
// Start the server with PAI_AI_PROFILES set to the engine to record (one ledger attempt per proposal).
// Numbers in captions are read back from the saved records.
import { writeFile } from "node:fs/promises";
import { openDemo } from "./demo-kit.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? ".state/demo-ai-video";
const { browser, context, page, pause, caption, chapter, card, click, type, orbit, spot, wheelTo, mark, elapsed, t0 } = await openDemo(out);
page.setDefaultTimeout(180_000);
const state = async () => (await page.request.get(`${base}/api/state`)).json();
const busyDone = () => page.locator(".busy").waitFor({ state: "detached", timeout: 1_800_000 }).catch(() => undefined);
async function advance(names) {
  for (const name of names) { await click(page.getByRole("button", { name, exact: true }), 300); await pause(800); await busyDone(); await pause(600); }
}
const facts = {};
const check = (r, id) => r.candidate.checks.find(c => c.id === id);
const rail = name => page.getByRole("navigation", { name: "生命周期" }).getByRole("link", { name });
const cadForm = async () => { await rail(/候选设计/).click(); await pause(700); await click(page.getByRole("tab", { name: "CAD 零件" }), 500);
  await click(page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }), 700); };
const um = v => (v * 1000).toFixed(2);

// ---------------------------------------------------------------- 0 title
await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
await card("AI 设计轴承座，求解器裁决", "维护者授权 → AI 提议 → 原生检查 → 物理寻优 → 正式复核 → 签名发布",
  ["真实模型 · 受控执行器", "共享账本 · 不自动重试", "CadQuery / OCCT B-Rep", "CalculiX 轴承载荷", "GP + NSGA-II 只排序", "AI 战绩"],
  "AI 不能放宽需求、验收或发布");
await pause(5500); await card(""); await pause(800);

// ---------------------------------------------------------------- 1 freeze + a compact housing that fails
mark("freeze");
await chapter("01", "冻结需求，紧凑化设计被拒绝");
await caption("6202 轴承座：Ø35 H7 轴承孔、壁厚 ≥ 5 mm、M8 地脚孔边距 ≥ 1.5 d", "这次把质量预算收紧到 175 g");
await click(page.getByRole("button", { name: "新建", exact: true }), 600);
await page.getByRole("button", { name: "创建评审任务" }).waitFor();
await page.getByLabel("任务名称").fill("");
await type(page.getByLabel("任务名称"), "6202 轴承座：AI 轻量化设计");
await page.getByLabel("准备作出的决策").fill("在不放宽任何要求的前提下，得到 ≤ 175 g、受载轴承孔仍保持圆度的轴承座。");
await click(page.getByRole("button", { name: "创建评审任务" }), 1400);
await page.getByText("任务和验收要求已冻结为版本 1。").waitFor(); await pause(1000);
await cadForm();
const massBox = page.locator("label", { hasText: "质量上限" }).locator("input"); await massBox.fill("175");
await click(page.getByRole("radio", { name: /轴承座紧凑化/ }), 500);
await caption("候选：底座缩短到 88 mm，地脚孔距 76 mm", "更轻、更紧凑，但螺栓离边缘更近");
await click(page.getByRole("button", { name: "生成并检查 CAD 零件" }), 400);
await page.getByRole("heading", { name: "零件检查拒绝" }).waitFor({ timeout: 300_000 });
await pause(1200); await orbit(240, -30); await pause(800);
let s = await state(); const compact = s.cads.at(-1);
facts.compact = { mass: compact.candidate.mass, edge: check(compact, "hole-edge-distance").observed, required: check(compact, "hole-edge-distance").required };
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption(`实测孔边距 ${facts.compact.edge} mm，要求 ≥ ${facts.compact.required} mm`, `${facts.compact.mass} g；其余检查通过，结论拒绝`);
await spot(page.locator(".check-table tr.fail"), 3200);

// ---------------------------------------------------------------- 2 grant + AI proposal + human reconciliation
mark("ai");
await chapter("02", "维护者授权，AI 自主修正");
await rail(/项目总览/).click(); await pause(900);
const auto = page.getByRole("region", { name: "AI 自主迭代" });
await wheelTo(auto, 80); await pause(500);
await caption("维护者签发授权：只允许 CAD 零件评审，最多 3 次，8 小时", "AI 可以自己提议并运行原生检查；不能放宽需求、验收、发布或关闭反馈");
await click(auto.getByRole("checkbox", { name: "AI 写 CadQuery 代码" }), 400);
await auto.getByRole("spinbutton", { name: "最多运行次数" }).fill("3");
await click(auto.getByRole("button", { name: "签发授权" }), 1200);
await type(auto.getByRole("textbox", { name: "目标" }), "在不放宽任何要求的前提下修正地脚孔边距，质量 ≤ 175 g，外形不超过冻结包络");
await click(auto.getByRole("button", { name: "让 AI 自主迭代" }), 600);
await caption("真实模型经受控执行器调用（共享账本，不自动重试）", "提示词里只有授权内的工具、零件族模板和带句柄的实测记录");
const run = auto.getByRole("region", { name: "最近一次自主迭代" });
await run.getByText(/目标达成|需要人工处理|轮数用完|没有给出可执行计划|授权用完/).first().waitFor({ timeout: 900_000 });
await pause(1200);
const resume = auto.getByRole("group", { name: "核对后继续" });
if (await resume.count()) {
  await wheelTo(resume, 120);
  await caption("执行器无法自动确认这次模型调用没有副作用，停下来等人核对", "回执显示：只读模式、没有工具活动；维护者记录理由后，在同一授权内执行");
  await spot(resume, 3200);
  await type(resume.getByRole("textbox", { name: "核对理由" }), "回执显示只读模式、没有工具活动，回答已人工审阅");
  await click(resume.getByRole("button", { name: "记录核对并在授权内执行" }), 600);
}
await page.getByRole("heading", { name: /零件检查(通过|拒绝)/ }).waitFor({ timeout: 600_000 });
await busyDone(); await pause(1500); await orbit(200, -30);
s = await state();
const aiPlan = s.assistantPlans.filter(p => p.source === "model").at(-1);
const aiCad = s.cads.at(-1);
facts.ai = { engine: aiPlan?.ai?.engine?.model ?? null, profile: aiPlan?.ai?.engine?.profile ?? null, parameters: aiCad.request.parameters ?? null,
  verdict: aiCad.verdict, mass: aiCad.candidate.mass, edge: check(aiCad, "hole-edge-distance").observed, estimate: aiPlan?.answer?.text?.slice(0, 200) ?? null,
  reconciled: Boolean(aiPlan?.ai?.reconciliation) };
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
const p = facts.ai.parameters ?? {};
await caption(`AI（${facts.ai.engine}）：底座 ${p.width ?? "?"} × ${p.baseDepth ?? "?"} × ${p.baseThickness ?? "?"} mm，孔距 ${p.boltPitch ?? "?"} mm`,
  `原生实测：孔边距 ${facts.ai.edge} mm，${facts.ai.mass} g，${facts.ai.verdict === "accepted-cad-part" ? "全部检查通过" : "仍有检查未通过"}`);
await spot(page.locator(".check-table"), 3600);

// ---------------------------------------------------------------- 3 bearing load + physics optimisation
mark("optimize");
await chapter("03", "冻结轴承载荷，物理寻优");
await cadForm();
await caption("再冻结结构要求：1 kN 上拔载荷经轴承作用在轴承孔上", "轴心位移 ≤ 10 µm，受载轴承孔失圆 ≤ 6 µm（接近 Ø35 轴承座的形状公差）");
await click(page.getByRole("checkbox", { name: "冻结结构要求并做 FEA" }), 600);
await spot(page.locator("fieldset", { hasText: "轴承径向载荷" }), 3000);
const opt = page.locator("section.card", { hasText: "物理寻优（FEA + 代理模型）" });
await wheelTo(opt, 80); await pause(400);
await caption("物理寻优：参考件 + Sobol 初始点，之后每轮代理模型排序、B-Rep 筛查、CalculiX 实测", "代理模型只负责排序，报告的每个点都是求解器实测值");
await click(opt.getByRole("button", { name: "运行物理寻优" }), 600);
await opt.getByRole("group", { name: "质量与实测轴承孔失圆散点图" }).waitFor({ timeout: 1_800_000 });
await busyDone(); await pause(1500);
s = await state();
const o = s.cadOptimizations.at(-1).result;
const best = o.points.find(q => q.index === o.lightestFeasible);
const ref = o.points[0];
facts.optimize = { points: o.points.length, solved: o.points.filter(q => q.fidelity === "fea").length, feasible: o.feasibleCount,
  reference: { mass: ref.mass, bore: ref.boreDistortionMm }, best: { origin: best.origin, parameters: best.parameters, mass: best.mass, bore: best.boreDistortionMm, deflection: best.deflectionMm },
  calibration: o.calibration };
await caption(`${facts.optimize.solved} 次 CalculiX 求解，${facts.optimize.feasible} 个实测可行点`,
  `最轻可行：${best.mass} g，失圆 ${um(best.boreDistortionMm)} µm（参考件 ${ref.mass} g / ${um(ref.boreDistortionMm)} µm）`);
await spot(opt.getByRole("group", { name: "质量与实测轴承孔失圆散点图" }), 4200);
await click(opt.getByRole("button", { name: "以此参数生成正式候选（两级网格复核）" }), 600);
await page.getByRole("heading", { name: /零件检查(通过|拒绝)/ }).waitFor({ timeout: 900_000 });
await busyDone(); await pause(1200);
s = await state(); const formal = s.cads.at(-1);
facts.formal = { verdict: formal.verdict, mass: formal.candidate.mass, bore: check(formal, "bore-distortion").observed, convergence: formal.fea?.candidate?.convergence };
const feaView = page.getByRole("button", { name: /应力/ }).first();
if (await feaView.count()) { await click(feaView, 800); await orbit(260, -25); }
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption(`正式复核（两级网格）：失圆 ${um(facts.formal.bore)} µm，${facts.formal.mass} g`,
  `两级网格差 ${(facts.formal.convergence?.boreDistortion * 100).toFixed(1)} %；${facts.formal.verdict === "accepted-cad-part" ? "全部检查通过" : "结论拒绝"}`);
await spot(page.locator(".check-table"), 3600);

// ---------------------------------------------------------------- 4 AI track record, feedback, release, sign
mark("release");
await chapter("04", "AI 战绩 → 处置失败 → 签名发布");
await rail(/项目总览/).click(); await pause(1000);
const track = page.locator("section.card", { hasText: "AI 战绩" }).first();
await wheelTo(track, 80);
await caption("AI 战绩：求解器对每个被执行提案的判定，不是自评", "这份记录也会回传给模型，下一次提案时据此修正");
await spot(track, 3600);
await page.goto(`${base}/#/validate?kind=cad-part&id=${compact.id}`); await pause(1200);
await caption("最初那个紧凑化设计的失败不会被删掉：登记反馈、复测、关闭", "失败案例全部关闭之前不能发布");
await click(page.getByRole("button", { name: /记录反馈：CAD 孔边距/ }), 900);
await advance(["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"]);
await rail(/发布交付/).click(); await pause(1500);
await caption("准入检查：结论通过、绑定当前需求、所有失败案例都已关闭", "发布由人批准；AI 没有这项权限");
await spot(page.getByLabel("发布准入检查"), 2600);
await click(page.getByRole("button", { name: "创建发布候选" }), 1200);
await click(page.getByRole("button", { name: "批准发布 R1" }), 1500);
await page.getByText("R1 已发布").first().waitFor({ timeout: 60_000 }); await busyDone(); await pause(1500);
const signed = page.getByRole("status").filter({ hasText: "签名有效" });
for (let i = 0; i < 2 && !(await signed.count()); i++) {
  await click(page.getByRole("button", { name: "核验签名" }), 600);
  await signed.waitFor({ timeout: 60_000 }).catch(() => undefined);
}
if (!(await signed.count())) throw new Error(`signature status: ${await page.locator('[role="status"]').allInnerTexts()}`);
facts.signer = (await signed.innerText()).includes("KMS") ? "AWS KMS ECDSA P-256" : "本机 Ed25519 密钥；托管站点使用 AWS KMS";
await caption("发布包：STEP、FEA 结果、寻优记录、AI 计划与核对理由、全部检查和审批", `清单已签名（${facts.signer}）`);
await spot(page.locator(".release-history"), 3400);
await caption(""); await chapter("");
await card("PAI Design Workbench", "AI 在授权内提议和执行，原生求解器给出结论，人批准发布",
  ["真实模型", "受控执行器", "B-Rep 实测", "CalculiX", "物理寻优", "签名交付"], "github.com/noteflowai/pai-design-workbench");
await pause(1200); await page.screenshot({ path: `${out}/endcard.png` }); await pause(3000);
const result = { marks: elapsed(), facts, totalSeconds: Math.round((Date.now() - t0) / 1000) };
await context.close(); await browser.close();
await writeFile(`${out}/marks.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
