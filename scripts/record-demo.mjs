// Records the generative industrial design demo against a local workbench with native CadQuery and the real
// bounded AI engine (Kiro). Usage: node scripts/record-demo.mjs http://127.0.0.1:4319 <output-dir>
// Overlays (title/chapter cards, cursor, click ripple, keystroke HUD, captions) exist only in this recording
// context. Every result shown is produced live by the native tools and the model; nothing is staged.
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? ".state/demo-video";
await mkdir(out, { recursive: true });
const icon = await readFile(new URL("../web/icon.svg", import.meta.url), "utf8");
const W = 1440, H = 900;
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
// The product CSP forbids inline styles; only this recording context bypasses it to draw overlays.
const context = await browser.newContext({ bypassCSP: true, viewport: { width: W, height: H }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: W, height: H } } });
await context.addInitScript(([logo]) => {
  localStorage.setItem("pai-theme", "dark"); localStorage.setItem("pai-assistant", "open"); localStorage.setItem("pai-rail", "expanded");
  localStorage.setItem("pai-assistant-mode", "ai"); localStorage.removeItem("pai-cad-code-draft");
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor{position:fixed;z-index:99999;width:22px;height:22px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s}
      #demo-cursor svg{filter:drop-shadow(0 2px 4px #000a)}
      .demo-ripple{position:fixed;z-index:99998;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:3px solid #6fe3c1;pointer-events:none;animation:demo-r .6s ease-out forwards}
      @keyframes demo-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.7);opacity:0}}
      #demo-caption{position:fixed;z-index:99997;left:50%;bottom:34px;transform:translateX(-50%) translateY(8px);max-width:960px;padding:14px 22px;border-radius:14px;
        background:linear-gradient(135deg,#0b1417f2,#12302af2);border:1px solid #2f6b5d;color:#fff;font:700 19px/1.45 "Noto Sans SC",Inter,sans-serif;
        box-shadow:0 18px 40px #000a;pointer-events:none;opacity:0;transition:opacity .35s,transform .35s}
      #demo-caption.on{opacity:1;transform:translateX(-50%) translateY(0)}
      #demo-caption small{display:block;font-weight:500;font-size:14px;color:#9fe3cc;margin-top:2px}
      #demo-chapter{position:fixed;z-index:99996;top:64px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:7px 16px 7px 8px;border-radius:999px;
        background:#0b1417e6;border:1px solid #2f6b5d;color:#e1ece9;font:700 13px/1 Inter,"Noto Sans SC",sans-serif;letter-spacing:.4px;opacity:0;transition:opacity .35s;pointer-events:none}
      #demo-chapter.on{opacity:1} #demo-chapter b{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#3fb596;color:#06231c;font-size:12px}
      #demo-keys{position:fixed;z-index:99996;right:28px;bottom:34px;display:flex;gap:6px;opacity:0;transition:opacity .25s;pointer-events:none}
      #demo-keys.on{opacity:1} #demo-keys kbd{font:700 15px/1 ui-monospace,monospace;padding:9px 12px;border-radius:8px;background:#e1ece9;color:#0b1417;box-shadow:0 3px 0 #7f9693}
      #demo-card{position:fixed;inset:0;z-index:100000;display:grid;place-content:center;justify-items:center;gap:18px;text-align:center;pointer-events:none;
        background:radial-gradient(1200px 700px at 50% 40%,#16483e 0%,#0b1417 60%,#05090b 100%);color:#e1ece9;font-family:Inter,"Noto Sans SC",sans-serif;opacity:0;transition:opacity .6s}
      #demo-card.on{opacity:1} #demo-card svg{width:112px;height:112px;filter:drop-shadow(0 14px 30px #000c)}
      #demo-card h1{font-size:46px;letter-spacing:-.8px;margin:0;font-weight:800}
      #demo-card p{margin:0;font-size:19px;color:#9fe3cc;font-weight:600}
      #demo-card .chips{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;max-width:980px;margin-top:6px}
      #demo-card .chips span{padding:7px 14px;border-radius:999px;border:1px solid #2f6b5d;background:#0f2a25;color:#cfe1dd;font-size:14px;font-weight:600}
      #demo-card small{color:#7f9693;font-size:14px}
      .demo-spot{outline:3px solid #6fe3c1 !important;outline-offset:3px;border-radius:8px;transition:outline-color .3s}`;
    document.head.append(style);
    const cursor = Object.assign(document.createElement("div"), { id: "demo-cursor",
      innerHTML: '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 2l7 18 2.6-7.4L19 10z" fill="#fff" stroke="#0b1417" stroke-width="1.5"/></svg>' });
    const caption = Object.assign(document.createElement("div"), { id: "demo-caption" });
    const chapter = Object.assign(document.createElement("div"), { id: "demo-chapter" });
    const keys = Object.assign(document.createElement("div"), { id: "demo-keys" });
    const card = Object.assign(document.createElement("div"), { id: "demo-card" });
    document.body.append(cursor, caption, chapter, keys, card);
    addEventListener("mousemove", e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", e => { const r = Object.assign(document.createElement("div"), { className: "demo-ripple" }); r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
      document.body.append(r); setTimeout(() => r.remove(), 700); cursor.style.transform = "scale(.85)"; }, true);
    addEventListener("mouseup", () => { cursor.style.transform = ""; }, true);
    window.__caption = (t, s) => { caption.innerHTML = t ? `${t}${s ? `<small>${s}</small>` : ""}` : ""; caption.classList.toggle("on", Boolean(t)); };
    window.__chapter = (n, t) => { chapter.innerHTML = n ? `<b>${n}</b>${t}` : ""; chapter.classList.toggle("on", Boolean(n)); };
    window.__keys = list => { keys.innerHTML = (list ?? []).map(k => `<kbd>${k}</kbd>`).join(""); keys.classList.toggle("on", Boolean(list?.length)); };
    window.__card = (title, sub, chips, foot) => {
      card.innerHTML = title ? `${logo}<h1>${title}</h1><p>${sub ?? ""}</p>${chips ? `<div class="chips">${chips.map(c => `<span>${c}</span>`).join("")}</div>` : ""}${foot ? `<small>${foot}</small>` : ""}` : "";
      card.classList.toggle("on", Boolean(title)); };
  });
}, [icon]);

const page = await context.newPage();
const pause = ms => page.waitForTimeout(ms);
const caption = (t, s = "") => page.evaluate(([a, b]) => window.__caption?.(a, b), [t, s]);
const chapter = (n, t = "") => page.evaluate(([a, b]) => window.__chapter?.(a, b), [n, t]);
const keys = list => page.evaluate(l => window.__keys?.(l), list);
const card = (t, s, chips, foot) => page.evaluate(([a, b, c, d]) => window.__card?.(a, b, c, d), [t, s, chips, foot]);
async function click(locator, wait = 500) {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await locator.boundingBox();
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 }); await pause(220); }
  await locator.click(); await pause(wait);
}
async function type(locator, text, delay = 24) {
  await click(locator, 200);
  for (const ch of text) { await page.keyboard.type(ch); await pause(delay); }
}
async function orbit(dx, dy) {
  await pause(700);
  const box = await page.locator(".viewport-canvas").boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 10 }); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 45 }); await page.mouse.up();
  await page.evaluate(() => getSelection()?.removeAllRanges()); await pause(300);
}
async function spot(locator, ms = 1800) {
  await locator.evaluate(e => e.classList.add("demo-spot")); await pause(ms); await locator.evaluate(e => e.classList.remove("demo-spot"));
}
const assistant = page.getByRole("complementary", { name: "AI 助手" });
const composer = assistant.locator("#studio-input");
const marks = [];
const mark = name => marks.push({ name, at: Date.now() });
const t0 = Date.now();

// ENDCARD_ONLY=1 only renders the end card still (Playwright's recorder drops the final frames on close,
// so the renderer appends this still to the end of the video).
const endCard = async () => card("PAI Design Workbench", "AI 提出设计，原生工具给出结论",
  ["Web · pai.oneai.host", "桌面：Linux · Windows · macOS", "MCP 外部 Agent", "Amazon Bedrock AgentCore（arm64）"], "github.com/noteflowai/pai-design-workbench");
if (process.env.ENDCARD_ONLY) {
  await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
  await endCard(); await pause(1200); await page.screenshot({ path: `${out}/endcard.png` });
  await context.close(); await browser.close(); process.exit(0);
}
// ---------------------------------------------------------------- title
await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
await card("PAI Design Workbench", "AI 生成工业设计 · 原生 CAD 验证 · 证据闭环",
  ["Kiro AI 引擎", "CadQuery / OCCT B-Rep", "隔离沙箱运行生成代码", "原生设计空间扫描", "EvalArc 独立对照", "Web · 桌面 · AgentCore"], "全部结果实时生成，未剪辑；等待画面已加速");
await pause(5000); await card(""); await pause(800);

// ---------------------------------------------------------------- 1 requirements
mark("requirements");
await chapter("01", "冻结需求");
await caption("从一个真实的设计决策开始", "NEMA 17 步进电机支架：在不丢失任何检查的前提下，能轻到多少？");
await click(page.getByRole("button", { name: "新建", exact: true }), 600);
await page.getByLabel("任务名称").fill("");
await type(page.getByLabel("任务名称"), "NEMA 17 电机支架 · 生成式轻量化");
await page.getByLabel("准备作出的决策").fill("在壁厚 ≥ 3 mm、孔边距 ≥ 1.5d、无装配干涉的前提下，找出最轻且可发布的支架设计。");
await click(page.getByRole("button", { name: "创建评审任务" }), 1400);
await caption("需求冻结为 v1", "之后每一次原生检查都绑定这份需求的哈希");
await pause(1800);

// ---------------------------------------------------------------- 2 native CAD
mark("native-cad");
await chapter("02", "原生 CAD 实时建模");
await caption("先试最直接的轻量化：板厚 4 → 2.5 mm", "CadQuery 2.8 / OCCT 7.9 在 B-Rep 上逐特征建模");
await page.goto(`${base}/#/design?lane=cad`); await pause(900);
await click(page.getByRole("radio", { name: /轻量化/ }), 400);
await click(page.getByRole("button", { name: "生成并检查 CAD 零件" }), 300);
await page.locator(".viewport").waitFor({ timeout: 60_000 });
await page.locator(".viewport[data-objects]:not([data-objects='0'])").waitFor({ timeout: 120_000 });
await caption("每完成一个特征，几何即流式推送到三维视口", "底座 → 安装板 → 加强筋 → NEMA 17 止口与孔 → 装配电机检查干涉");
await pause(1200); await orbit(240, -40); await orbit(-160, 25);
await page.getByRole("heading", { name: "零件检查拒绝" }).waitFor({ timeout: 240_000 });
await pause(6000);
const failRow = page.locator(".check-table tr.fail");
await failRow.scrollIntoViewIfNeeded(); await pause(400);
await caption("原生检查拒绝：轻了 34%，但壁厚只有 2.5 mm", "实测值 · 要求 · 余量条；EvalArc 独立确认 1 项回归，失败案例原样保留");
await spot(failRow, 2600);

// ---------------------------------------------------------------- 3 AI writes the design
mark("ai");
await chapter("03", "AI 生成设计代码");
await caption("在失败的检查上直接“问 AI”", "自动带上实测值与要求；AI 引擎：Kiro（主 → 备 → 二备）");
await click(failRow.getByRole("button", { name: /问 AI/ }), 900);
await composer.fill("");
await type(composer, "cad-1 的最小壁厚 2.5 mm 低于 3 mm。请用 cad-code 从模板出发写一份 CadQuery 代码：板厚改为 3.2 mm，其余接口与加强筋保持不变，并说明依据。", 14);
await click(assistant.getByRole("button", { name: "生成计划 ↵" }), 600);
await caption("模型只能提出计划", "计划按与表单相同的 schema 校验；没有验收、发布或推进反馈的权限");
const codeCard = assistant.getByRole("article").filter({ has: page.getByText("查看生成的 CadQuery 代码") }).last();
await codeCard.waitFor({ timeout: 300_000 });
await pause(800);
await codeCard.scrollIntoViewIfNeeded();
await caption("AI 写出了 CadQuery 代码", "带引用的回答 · 代码行数与 SHA-256 · 标出变更 · 等你确认");
await click(codeCard.getByText("查看生成的 CadQuery 代码"), 600);
await codeCard.locator("pre.code").evaluate(e => e.scrollTo({ top: 0 }));
await pause(1800);
await codeCard.locator("pre.code").evaluate(e => e.scrollTo({ top: e.scrollHeight, behavior: "smooth" }));
await pause(1800);
await click(codeCard.getByText("查看生成的 CadQuery 代码"), 300);
await caption("确认后，代码在三层隔离沙箱中运行", "AST 策略 → 进程锁定（rlimit + 审计钩子）→ bubblewrap（无网络、只读、无凭据）");
await click(codeCard.getByRole("button", { name: "确认执行" }), 400);
await page.getByRole("heading", { name: /零件检查(通过|拒绝)/ }).waitFor({ timeout: 300_000 });
await pause(6000);
await page.locator(".viewport").scrollIntoViewIfNeeded(); await orbit(220, -30);
const verdict = (await page.getByRole("heading", { name: /零件检查(通过|拒绝)/ }).innerText()).trim();
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption(verdict === "零件检查通过" ? "AI 生成的设计通过全部 7 项原生检查" : "AI 生成的设计仍未通过——结论只来自原生检查",
  "结论来自与预设相同的 B-Rep 检查；生成者无法给自己打分");
await spot(page.locator(".check-table"), 2600);

// ---------------------------------------------------------------- 4 design space
mark("sweep");
await chapter("04", "原生设计空间扫描");
await caption("不止一个答案：在参数空间里找最轻的可行解", "每个点都原生建模实测，不是代理模型");
await page.goto(`${base}/#/design?lane=cad`); await pause(700);
const panel = page.locator(".card", { has: page.getByRole("heading", { name: "设计空间扫描" }) });
// Wheel scrolling (as a user would): programmatic smooth scrolls are cancelled by the assistant timeline's own scrolling.
async function wheelTo(locator, offset = 70) {
  for (let i = 0; i < 30; i++) {
    const box = await locator.boundingBox(); if (!box) return;
    const d = box.y - offset; if (Math.abs(d) < 12) return;
    await page.mouse.move(640, 450); await page.mouse.wheel(0, Math.sign(d) * Math.min(Math.abs(d), 160)); await pause(60);
  }
}
const toPanel = () => wheelTo(panel);
await toPanel(); await pause(900);
const axis = name => panel.getByRole("textbox", { name });
await axis(/板厚 t/).fill(""); await type(axis(/板厚 t/), "2.5, 3, 3.5, 4");
await axis(/宽度 W/).fill(""); await type(axis(/宽度 W/), "50, 60");
await axis(/安装板高度 H/).fill(""); await type(axis(/安装板高度 H/), "43.5, 46");
await click(panel.getByRole("button", { name: "运行扫描" }), 600);
await toPanel();
await caption("16 个参数组合逐个原生建模、实测", "进度逐点流式显示；每点约 6 秒");
await panel.getByRole("group", { name: "质量与最小壁厚散点图" }).waitFor({ timeout: 400_000 });
// Playwright's screencast falls behind while native work saturates the CPU; let it catch up before the next scene
// (the static wait is accelerated by tools/render_demo.py).
await pause(8000);
await wheelTo(panel.getByRole("group", { name: "质量与最小壁厚散点图" }), 150); await pause(1500);
await caption("16 个原生实测点：绿色可行，红色违规；圆环为帕累托前沿", "默认选中满足全部检查的最轻点");
const pts = panel.locator(".sweep-plot .pt");
await pause(2000);
for (const i of [0, 3, 6, 9, 12]) { const p = pts.nth(i); const b = await p.boundingBox(); if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 }); await pause(700); } }
const lightest = panel.locator(".sweep-plot .pt.ok").first();
await spot(panel.locator(".sweep-pick"), 3000);
await caption("扫描只排序、不验收", "选中的点必须作为正式候选，重新走基准对照与 EvalArc");
await click(panel.getByRole("button", { name: "以此参数生成正式候选" }), 400);
void lightest;
await page.getByRole("heading", { name: "零件检查通过" }).waitFor({ timeout: 300_000 });
await pause(6000); await orbit(-200, 30);
await caption("最轻可行设计：t = 3 mm，37.4 g（比基准轻 23%）", "可编辑 STEP、STL、GLB、工程视图，全部带 SHA-256");
await pause(2600);

// ---------------------------------------------------------------- 5 keyboard + lifecycle
mark("finish");
await chapter("05", "专业工作流");
await caption("Ctrl+K：命令、跳转，或直接问 AI", "侧栏 [ 收起 · 深色 / 浅色主题 · WCAG 2.1 AA");
await keys(["Ctrl", "K"]); await page.keyboard.press("Control+k"); await pause(900); await keys([]);
await page.keyboard.type("总览", { delay: 90 }); await pause(700); await page.keyboard.press("Enter"); await pause(1600);
await caption("全生命周期由记录推导", "需求 → 候选 → 原生验证 → 失败回放 → 反馈复测 → 发布交付");
await pause(2800);
await caption(""); await chapter("");

// ---------------------------------------------------------------- end card
await endCard(); await pause(1200);
await page.screenshot({ path: `${out}/endcard.png` });
await pause(3000);
const result = { marks: marks.map(m => ({ name: m.name, seconds: Math.round((m.at - t0) / 100) / 10 })), aiVerdict: verdict, totalSeconds: Math.round((Date.now() - t0) / 1000) };
await context.close(); await browser.close();
await writeFile(`${out}/marks.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
