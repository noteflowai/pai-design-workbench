// Records the end-to-end interaction demo against a local workbench with native Blender and CadQuery.
// Usage: node scripts/record-demo.mjs http://127.0.0.1:4319 <output-dir>
// Overlays (cursor, click ripple, captions) are injected only into this recording session.
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? ".state/demo-video";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
// The product CSP forbids inline styles; only this recording context bypasses it to draw overlays.
const context = await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 }, recordVideo: { dir: out, size: { width: 1440, height: 900 } } });
await context.addInitScript(() => {
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `#demo-cursor{position:fixed;z-index:99999;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s}
      #demo-cursor svg{filter:drop-shadow(0 2px 3px #0006)} .demo-ripple{position:fixed;z-index:99998;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
      border:3px solid #1d6b5b;pointer-events:none;animation:demo-r .6s ease-out forwards}@keyframes demo-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
      #demo-caption{position:fixed;z-index:99997;left:50%;bottom:26px;transform:translateX(-50%);max-width:900px;padding:12px 20px;border-radius:12px;
      background:#0d1a20e8;color:#fff;font:600 17px/1.5 "Noto Sans SC",sans-serif;box-shadow:0 12px 30px #0006;pointer-events:none;transition:opacity .3s}
      #demo-caption small{display:block;font-weight:500;font-size:13px;color:#9fe3cc}`;
    document.head.append(style);
    const cursor = document.createElement("div"); cursor.id = "demo-cursor";
    cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2l7 18 2.6-7.4L19 10z" fill="#fff" stroke="#111" stroke-width="1.5"/></svg>';
    const caption = document.createElement("div"); caption.id = "demo-caption"; caption.style.opacity = "0";
    document.body.append(cursor, caption);
    addEventListener("mousemove", e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", e => { const r = document.createElement("div"); r.className = "demo-ripple"; r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
      document.body.append(r); setTimeout(() => r.remove(), 700); cursor.style.transform = "scale(.85)"; }, true);
    addEventListener("mouseup", () => { cursor.style.transform = ""; }, true);
    window.__caption = (t, s) => {
      caption.innerHTML = t ? `${t}${s ? `<small>${s}</small>` : ""}` : ""; caption.style.opacity = t ? "1" : "0"; };
  });
});
const page = await context.newPage();
// Native work runs in real time; tools/render_demo.py speeds up visually static waiting spans afterwards.
const waiting = (promise) => promise;
const pause = (ms) => page.waitForTimeout(ms);
const caption = async (t, s = "") => { await page.evaluate(([a, b]) => window.__caption?.(a, b), [t, s]); };
async function click(locator, wait = 500) {
  const box = await locator.boundingBox();
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 }); await pause(180); }
  await locator.click(); await pause(wait);
}
async function type(locator, text) {
  await click(locator, 200);
  for (const ch of text) { await page.keyboard.type(ch); await pause(28); }
}
async function orbit(dx, dy) {
  await pause(900); // let smooth scrolling settle so the drag starts on the canvas
  const box = await page.locator(".viewport-canvas").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 8 }); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 40 }); await page.mouse.up();
  await page.evaluate(() => getSelection()?.removeAllRanges()); await pause(400);
}
const assistant = page.getByRole("complementary", { name: "AI 助手" });
const rail = (name) => page.getByRole("navigation", { name: "生命周期" }).getByRole("link", { name });
const waitConfirmed = (n) => waiting(assistant.locator(".confirmed").nth(n).waitFor({ timeout: 240_000 }));

await page.goto(`${base}/`); await pause(1200);
await caption("PAI Design Workbench", "需求 → 候选设计 → 原生验证 → 失败回放 → 反馈复测 → 交付试用");
await pause(2200);
await click(page.getByRole("button", { name: "新建评审任务" }));
await caption("1 · 冻结需求", "创建即冻结需求 v1，之后每次检查都绑定需求哈希");
await page.getByLabel("任务名称").fill("");
await type(page.getByLabel("任务名称"), "NEMA 17 电机支架与检测工作单元");
await page.getByLabel("准备作出的决策").fill("判断轻量化支架与检测相机布局能否在不丢失基准通过项的前提下采用，并定位需要回退的失败案例。");
await click(page.getByRole("button", { name: "创建评审任务" }), 1400);
await caption("全生命周期总览", "每个阶段的状态与“下一步”都由保存的记录推导");
await pause(2200);

await caption("2 · AI 助手：用专业语言描述意图", "解析为类型化计划，标出每项约束的收紧/放宽；确认前不执行");
await type(assistant.locator("#studio-input"), "评估 NEMA 17 电机支架轻量化方案：壁厚不低于 3 mm，质量不超过 80 g");
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 1600);
await caption("计划卡：CadQuery 参数化零件", "确认后才调用原生 CAD 内核（OCCT 7.9）");
await pause(1500);
await click(assistant.getByRole("article", { name: /计划 CadQuery/ }).getByRole("button", { name: "确认执行" }), 300);
await caption("3 · 实时原生建模", "每完成一个特征，B-Rep 几何即推送到三维视口；最后叠加电机做装配干涉检查");
await page.locator(".viewport").waitFor({ timeout: 60_000 });
await page.locator(".viewport").evaluate(e => e.scrollIntoView({ block: "center", behavior: "smooth" }));
await waiting(page.locator(".viewport[data-objects]:not([data-objects='0'])").waitFor({ timeout: 120_000 }));
await pause(1500); await orbit(260, -40); await orbit(-180, 30);
await waitConfirmed(0);
await page.locator(".viewport").evaluate(e => e.scrollIntoView({ block: "center", behavior: "smooth" }));
await caption("结论：零件检查拒绝", "轻量化 48.4 → 31.9 g，但实测最小壁厚 2.5 mm < 3 mm；EvalArc 独立确认 1 项回归");
await pause(1800);
await click(page.getByRole("button", { name: "顶视" }), 900);
await click(page.getByRole("button", { name: "前视" }), 900);
await click(page.getByLabel("X 光透视 (Alt+Z)"), 900);
await click(page.getByLabel("X 光透视 (Alt+Z)"), 300);
await click(page.getByRole("button", { name: "透视" }), 700);
await page.getByRole("slider", { name: "构建阶段时间轴" }).scrollIntoViewIfNeeded();
await caption("阶段时间轴", "回看每一步原生几何，阶段文件都有 SHA-256");
for (const v of ["0", "1", "2", "3", "4", "6"]) { await page.getByRole("slider", { name: "构建阶段时间轴" }).fill(v); await pause(650); }
await page.locator(".drawings").scrollIntoViewIfNeeded(); await pause(400);
await caption("OCCT 工程视图与逐项实测", "接口、壁厚、孔边距、质量、装配干涉都在 B-Rep 上测量");
await pause(2600);

await page.locator("main").evaluate(() => scrollTo({ top: 0, behavior: "smooth" })); await pause(500);
await caption("Blender 工作单元：检查相机视线", "同样由 AI 计划驱动，原生射线与 Cycles 渲染进度实时显示");
await type(assistant.locator("#studio-input"), "生成带遮挡的 Blender 工作单元，占地不超过 12 平方米，包络半径 1.4 m");
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 1200);
await click(assistant.getByRole("article", { name: /计划 Blender 原生场景/ }).getByRole("button", { name: "确认执行" }), 300);
await page.locator(".viewport").waitFor({ timeout: 60_000 });
await page.locator(".viewport").evaluate(e => e.scrollIntoView({ block: "center", behavior: "smooth" }));
await waiting(page.locator(".viewport[data-objects]:not([data-objects='0'])").waitFor({ timeout: 120_000 }));
await pause(1200); await orbit(200, -30);
await waitConfirmed(1);
await caption("射线被遮挡 → 场景检查拒绝", "红色为实际命中点，虚线为预期视线");
await click(page.getByRole("button", { name: "检查相机" }), 1600);
await click(page.getByRole("button", { name: "透视" }), 600);
await click(page.getByRole("button", { name: "基准布局", exact: true }), 1600);
await click(page.getByRole("button", { name: "候选布局", exact: true }), 800);

await caption("工厂孪生：先冻结标准，再导入证据", "Robot Reel v0.18.0 逐字节样本；12 个配对种子全部保留");
await type(assistant.locator("#studio-input"), "评审工厂维护与能源方案：产出不能下降，EV 充电不低于 80%，车间不超过 25 °C");
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 1200);
await click(assistant.getByRole("article", { name: "计划 先冻结工厂验收标准" }).getByRole("button", { name: "确认执行" }), 900);
await click(assistant.getByRole("article", { name: /计划 导入已复核/ }).getByRole("button", { name: "确认执行" }), 1200);
await page.getByRole("heading", { name: "维护方案拒绝" }).waitFor();
await page.locator(".charts").scrollIntoViewIfNeeded();
await caption("净产出 +133 仍被拒绝", "seed 3、11 产出下降；seed 10 EV 服务 74%；能耗不抵消");
await pause(3200);

await caption("4 · 失败案例 → 反馈 → 新复测 → 关闭", "回到 CAD：恢复基准参数，在原要求下重新生成");
await click(rail(/原生验证/), 600);
await click(page.getByRole("button", { name: /CAD 零件 NEMA 17 支架 · 轻量化/ }), 900);
await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).scrollIntoViewIfNeeded();
await click(page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }), 1200);
for (const name of ["记录复现", "分配处理", "提出回退方案", "恢复基准参数并复测", "关闭已复测反馈"]) {
  await click(page.getByRole("button", { name, exact: true }), 300);
  await waiting(page.locator(".busy").waitFor({ state: "detached", timeout: 240_000 }).catch(() => undefined));
  await pause(900);
}
await caption("反馈关闭，原失败记录保留", "复测回执绑定当前需求版本；不会把失败改写成通过");
await pause(2200);
await click(rail(/交付试用/), 800);
await click(page.getByRole("button", { name: "生成案例草稿" }), 1500);
await caption("5 · 可核验交付与案例草稿", "保留失败与范围限制；工作台不发送、不发布");
await pause(2200);
await click(rail(/项目总览/), 900);
await caption("闭环总览", "所有结论来自原生工具与独立检查；AI 只提出计划");
await pause(3500);
await caption("");
await context.close();
await browser.close();
console.log(JSON.stringify({ video: out }));
