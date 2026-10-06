// Read-only acceptance of the hosted site through the real login (Cognito + ALB): signs in with the private
// administrator login (never printed), opens every lifecycle view of the latest project at desktop and phone width,
// checks the AI cards and capabilities, and writes screenshots. Creates, runs and changes nothing.
// Usage: node scripts/hosted-ui-check.mjs <output-dir>
import { readFile, mkdir, chmod } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const site = "https://pai.oneai.host";
const out = process.argv[2] ?? ".state/hosted-ui";
await mkdir(out, { recursive: true });
const login = JSON.parse(await readFile(".state/deploy/admin-login.json", "utf8"));
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
const report = { site, views: {}, errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", e => report.errors.push(e.message));
  await page.goto(site, { timeout: 60_000 });
  await page.locator('input[name="username"]:visible').first().fill(login.username);
  await page.locator('input[type="password"]:visible').first().fill(login.password);
  await page.locator('input[name="signInSubmitButton"]:visible').first().click();
  await page.waitForURL(`${site}/`, { timeout: 60_000 });
  await page.getByRole("navigation", { name: "生命周期" }).waitFor({ timeout: 60_000 });
  await context.storageState({ path: ".state/deploy/auth-state.json" }); await chmod(".state/deploy/auth-state.json", 0o600);
  const state = await (await page.request.get(`${site}/api/state`)).json();
  const cap = state.capabilities;
  report.capabilities = { authenticatedWorkspace: cap.authenticatedWorkspace, engines: cap.assistant?.engines, images: cap.assistant?.images,
    families: Object.keys(cap.cad?.families ?? {}), sweepGrids: Object.keys(cap.cad?.sweep?.grids ?? {}), familyStructural: Object.keys(cap.physics?.familyStructural ?? {}),
    cam: Boolean(cap.cad?.cam), signing: cap.signing?.kms ?? null, projects: state.projects.length };
  assert.equal(cap.authenticatedWorkspace, true);
  assert.deepEqual(report.capabilities.families.sort(), ["nema17-bracket", "pillow-block"]);
  for (const [view, name] of [["overview", "项目总览"], ["requirements", "需求冻结"], ["design", "候选设计"], ["validate", "原生验证"], ["evidence", "失败回放"], ["feedback", "反馈复测"], ["deliver", "发布交付"]]) {
    await page.goto(`${site}/#/${view}`); await page.waitForTimeout(1500);
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      report.views[`${view}@${w}`] = { overflowPx: overflow };
      await page.screenshot({ path: `${out}/${view}-${w}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    if (view === "overview" && state.projects.length) {
      report.overviewCards = { autonomy: await page.getByRole("region", { name: "AI 自主迭代" }).count(),
        trackRecord: await page.getByText("AI 战绩", { exact: true }).count() };
    }
    void name;
  }
  report.result = report.errors.length === 0 && Object.values(report.views).every(v => (v.overflowPx ?? 0) <= 0) ? "passed" : "failed";
} catch (e) { report.result = "failed"; report.error = `${e.name}: ${String(e.message).slice(0, 300)}`; }
finally { await browser.close(); }
console.log(JSON.stringify(report));
if (report.result !== "passed") process.exitCode = 1;
