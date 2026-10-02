// Records the AI + Blender factory production-line demo against a local workbench with native Blender 5.2 and the
// real bounded AI engine (Kiro). Usage: node scripts/record-factory-demo.mjs http://127.0.0.1:4319 <output-dir>
// Overlays exist only in this recording context. Every geometry, measurement, render and AI plan shown is produced
// live; captions with numbers are read back from the saved records, not written in advance.
import { writeFile } from "node:fs/promises";
import { openDemo } from "./demo-kit.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? ".state/demo-plant-video";
const { browser, context, page, pause, caption, chapter, keys, card, click, type, orbit, spot, wheelTo, assistant, composer, mark, elapsed, t0 } = await openDemo(out);

const endCard = async () => card("PAI Design Workbench", "AI 提出布局，Blender 原生生成并实测",
  ["Blender 5.2 · Cycles · BVH 射线", "Kiro AI 引擎", "EvalArc 独立对照", "Web · 桌面 · MCP"], "github.com/noteflowai/pai-design-workbench");
if (process.env.ENDCARD_ONLY) {
  await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
  await endCard(); await pause(1200); await page.screenshot({ path: `${out}/endcard.png` });
  await context.close(); await browser.close(); process.exit(0);
}
const state = async () => (await page.request.get(`${base}/api/state`)).json();
const plants = async () => (await state()).scenes.filter(s => s.request.variant === "plant");
const measured = (s, id) => s.candidate.checks.find(c => c.id === id);
const viewport = page.locator(".viewport");
const verdictHeading = page.getByRole("heading", { name: /场景检查(通过|拒绝)/ });

// ---------------------------------------------------------------- title
await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
await card("AI + Blender 设计工厂产线", "对话描述 → Blender 原生生成 → 射线实测 → AI 修正 → 复测通过",
  ["CNC 加工中心 × 六轴机器人", "安全围栏 · 输送线 · 货架", "AGV · 桥式起重机 · 检测相机", "Cycles 渲染 · 动画", "Kiro AI 引擎", "EvalArc 独立对照"],
  "全部结果实时生成，未剪辑；静止的等待画面已加速");
await pause(5500); await card(""); await pause(800);

// ---------------------------------------------------------------- 1 requirements
mark("requirements");
await chapter("01", "冻结需求");
await caption("一个真实的产线规划问题", "6 工位 CNC 机加工线要塞进 650 m² 的厂房，同时满足通道、安全间距、相机覆盖与疏散");
await click(page.getByRole("button", { name: "新建", exact: true }), 600);
await page.getByLabel("任务名称").fill("");
await type(page.getByLabel("任务名称"), "6 工位 CNC 机加工产线布局");
await page.getByLabel("准备作出的决策").fill("在厂房 ≤ 650 m²、AGV 通道净宽 ≥ 2.4 m、围栏安全间距 ≥ 0.5 m、每个工位都被检测相机看到、疏散 ≤ 25 m 的前提下确定产线布局。");
await click(page.getByRole("button", { name: "创建评审任务" }), 1400);
await caption("需求冻结为 v1", "之后每一次原生检查都绑定这份需求的哈希");
await pause(1800);

// ---------------------------------------------------------------- 2 describe the line
mark("describe");
await chapter("02", "用一句话描述产线");
await caption("工程师按经验给出初版参数", "为了让机器人离围栏更远，把围栏从参考的 4.0 m 加大到 4.2 m");
await click(assistant.getByRole("button", { name: "规则", exact: true }), 400);
await type(composer, "设计 6 工位 CNC 机加工产线：节距 4.5 m，安全围栏加大到 4.2 m，AGV 通道 2.4 m，检测相机龙门 2.8 m，3 台 AGV，2 排货架，厂房 ≤ 650 m²", 16);
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 900);
const firstCard = assistant.getByRole("article", { name: /计划 Blender 工厂产线/ }).last();
await firstCard.waitFor({ timeout: 30_000 }); await firstCard.scrollIntoViewIfNeeded();
await caption("对话被解析成类型化计划", "7 个布局参数 + 5 条要求，按与表单相同的 schema 校验；确认前不会运行任何工具");
await spot(firstCard, 2600);

// ---------------------------------------------------------------- 3 native Blender build
mark("blender");
await chapter("03", "Blender 原生生成");
await click(firstCard.getByRole("button", { name: "确认执行" }), 600);
await caption("Blender 5.2 在后台逐阶段生成整座车间", "先生成 4 工位参考产线作为基准，再生成候选；每个阶段的 GLB 实时推送到三维视口");
await page.locator(".viewport[data-objects]:not([data-objects='0'])").waitFor({ timeout: 180_000 });
await wheelTo(viewport, 60);
await pause(2500); await orbit(70, -10);
// Follow the live run: once the candidate is being built, narrate it and orbit; then wait for the saved verdict.
let narrated = false;
for (let i = 0; i < 600 && !(await verdictHeading.isVisible()); i++) {
  const steps = await page.locator(".live-steps").first().innerText().catch(() => "");
  if (!narrated && steps.includes("候选产线") && (await page.locator(".viewport[data-stage='8']").count())) {
    narrated = true;
    await caption("候选产线：厂房 → 输送线 → CNC → 机器人 → 围栏 → 货架 → AGV/起重机 → 检测相机", "机器人为关节层级；AGV、输送线物料和起重机带关键帧");
    await pause(1500); await orbit(-60, 8); await pause(800); await orbit(90, -12);
    await caption("Cycles 路径追踪渲染进行中", "同一份 .blend 同时用于渲染和几何实测");
  }
  await pause(2000);
}
await verdictHeading.waitFor({ timeout: 60_000 });
await pause(8000);

// ---------------------------------------------------------------- 4 measured rejection
mark("rejected");
await chapter("04", "射线实测：发现耦合问题");
const first = (await plants()).at(-1);
const aisle = measured(first, "aisle-clearance"), guard = measured(first, "guard-clearance"), cover = measured(first, "camera-coverage");
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(400);
const failRow = page.locator(".check-table tr.fail").first();
await caption(first.verdict === "rejected" ? `原生检查拒绝：AGV 通道净宽只有 ${aisle.observed} m（要求 ≥ ${aisle.required} m）` : "原生检查结论",
  `围栏间距 ${guard.observed} m 通过，但加大的围栏挤占了通道；${cover.observed}/${cover.required} 个工位相机覆盖。EvalArc 独立确认 ${first.diff?.blocking_changes} 项回归`);
await spot(page.locator(".check-table"), 3200);
await wheelTo(viewport, 70); await pause(500);
await caption("每条检测相机射线的首个命中都是工件", "BVH 射线在 41 个截面 × 3 个高度上测量通道最窄处");
await click(viewport.getByRole("button", { name: "顶视" }), 1800);
await click(viewport.getByRole("button", { name: "透视" }), 1200);
await click(viewport.getByRole("button", { name: "▶ 播放产线动画" }), 600);
await caption("最终 GLB 带原生动画：机器人取放、AGV 往返、起重机行走", "演示用运动，不是动力学或节拍仿真");
await orbit(80, -8); await pause(2500); await orbit(-110, 10); await pause(2000);
const renders = page.locator(".plant-renders");
await wheelTo(renders, 90); await pause(600);
await caption("Cycles 渲染：候选产线全景与检测相机视角", "可下载可编辑的 .blend 与带动画的 GLB，全部带 SHA-256");
await pause(3500);

// ---------------------------------------------------------------- 5 AI fixes the layout
mark("ai");
await chapter("05", "AI 修正布局");
await wheelTo(page.locator(".check-table"), 90); await pause(400);
await caption("在失败的检查上直接“问 AI”", "自动带上实测值、当前布局与要求；AI 引擎：Kiro（主 → 备 → 二备）");
await click(failRow.getByRole("button", { name: /问 AI/ }), 900);
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 600);
await caption("模型只能提出计划", "计划按 plant-layout 的 schema 重新校验；没有验收、发布或推进反馈的权限");
// Wait for the saved model run to settle (a running record exists before the answer), then for its first card.
let plan;
for (let i = 0; i < 210 && !plan; i++) {
  plan = (await state()).assistantPlans.find(p => p.source === "model" && p.state !== "running" && p.plans.some(x => x.tool === "plant-layout"));
  if (!plan) await pause(2000);
}
if (!plan) throw new Error("AI engine returned no plant-layout plan; see the saved assistant plan");
const step = plan.plans.find(p => p.tool === "plant-layout");
const aiCard = assistant.getByRole("article", { name: `计划 ${step.title}` });
await aiCard.waitFor({ timeout: 60_000 });
await pause(1000); await aiCard.scrollIntoViewIfNeeded();
const changed = step.changes.filter(c => c.direction !== "same").map(c => `${c.field.replace("layout.", "")} ${c.from} → ${c.to}`);
const options = plan.plans.filter(p => p.tool === "plant-layout").length;
await caption(`AI 提出${options > 1 ? ` ${options} 个方案，首选` : ""}：${changed.join("，") || "保持布局"}`, `${plan.ai?.engine?.profile === "kiro-primary" ? "Kiro 主账号" : plan.ai?.engine?.profile ?? "AI"}（${plan.ai?.engine?.model ?? "模型"}） · 回答引用已存记录 · 标出每项变更`);
await spot(aiCard, 3000);
await caption("确认后，Blender 重新生成并实测", "同一套原生检查，基准对照与 EvalArc 重新执行");
await click(aiCard.getByRole("button", { name: "确认执行" }), 600);
await page.locator(".viewport[data-objects]:not([data-objects='0'])").waitFor({ timeout: 180_000 });
await wheelTo(viewport, 60);
await pause(2000); await orbit(60, -8);
await aiCard.getByText(/已执行 ·/).waitFor({ timeout: 900_000 });
await verdictHeading.waitFor({ timeout: 60_000 });
await pause(8000);

// ---------------------------------------------------------------- 6 result
mark("result");
await chapter("06", "复测结论");
const second = (await plants()).at(-1);
const a2 = measured(second, "aisle-clearance"), f2 = measured(second, "footprint-area");
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(400);
await caption(second.verdict === "accepted-static-scene" ? `AI 修正后的布局通过全部 5 项原生检查` : "AI 修正后的布局仍未通过——结论只来自原生检查",
  `通道净宽 ${a2.observed} m（≥ ${a2.required}），厂房 ${f2.observed} m²（≤ ${f2.required}）；生成者无法给自己打分`);
await spot(page.locator(".check-table"), 3200);
await wheelTo(viewport, 70); await pause(500);
const play = viewport.getByRole("button", { name: "▶ 播放产线动画" });
if (await play.count()) await click(play, 600);
await orbit(-90, -6); await pause(2500); await orbit(120, 10); await pause(2000);
const compare = page.locator("#compare");
if (await compare.count()) {
  await wheelTo(compare, 90); await pause(500);
  await caption("候选对比：两版布局逐项对照", "失败的那一版原样保留，作为待反馈复测的案例");
  await pause(3500);
}
await caption("Ctrl+K：命令、跳转，或直接问 AI", "全生命周期由记录推导：需求 → 候选 → 验证 → 失败回放 → 反馈复测 → 发布");
await keys(["Ctrl", "K"]); await page.keyboard.press("Control+k"); await pause(900); await keys([]);
await page.keyboard.type("总览", { delay: 90 }); await pause(700); await page.keyboard.press("Enter"); await pause(3000);
await caption(""); await chapter("");

// ---------------------------------------------------------------- end card
await endCard(); await pause(1200);
await page.screenshot({ path: `${out}/endcard.png` });
await pause(3000);
const result = { marks: elapsed(), first: { id: first.id, verdict: first.verdict, aisle: aisle.observed, guard: guard.observed, coverage: cover.observed, blocking: first.diff?.blocking_changes },
  ai: { profile: plan.ai?.engine?.profile, model: plan.ai?.engine?.model, changes: changed, confirmed: true },
  second: { id: second.id, verdict: second.verdict, aisle: a2.observed, footprint: f2.observed, layout: second.request.layout }, totalSeconds: Math.round((Date.now() - t0) / 1000) };
await context.close(); await browser.close();
await writeFile(`${out}/marks.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
