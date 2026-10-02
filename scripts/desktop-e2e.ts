import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "@playwright/test";

/**
 * Desktop package check: launches the packaged Electron app (linux-unpacked), with an isolated user-data
 * directory, and drives a classic case (C2 lightweight bracket) through the real UI and native CadQuery.
 */
// --smoke (CI without native tools): launch, security, menus, bridge and the fresh-install path; no CAD run.
const smoke = process.argv.includes("--smoke");
const exe = process.env.PAI_DESKTOP_EXE ?? join(process.cwd(), ".state/desktop/dist/linux-unpacked/pai-workbench");
const userData = await mkdtemp(join(tmpdir(), "pai-desktop-"));
const t0 = Date.now();
const step = (m: string) => console.error(`[desktop-e2e +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
step(`launch ${exe}${smoke ? " (smoke)" : ""}`);
const appRun = await electron.launch({ executablePath: exe, args: [],
  env: { ...process.env, PAI_DESKTOP_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: "0" } as Record<string, string>, timeout: 60_000 });
let origin = "";
const report: Record<string, unknown> = { schema: "pai-desktop-e2e-1", checkedAt: new Date().toISOString(), executable: exe };
appRun.process().stderr?.on("data", d => process.stderr.write(`[electron] ${d}`));
try {
  // Outside the test runner Playwright has no default timeouts; a stalled step must fail, not hang.
  appRun.context().setDefaultTimeout(60_000);
  const win = await appRun.firstWindow({ timeout: 60_000 });
  step("window open");
  await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  step("workbench loaded");
  report.startupSeconds = Math.round((Date.now() - t0) / 100) / 10;
  origin = new URL(win.url()).origin;
  const info = await appRun.evaluate(({ app, Menu, BrowserWindow }) => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, menu: Menu.getApplicationMenu()!.items.map((i: { label: string }) => i.label), userData: app.getPath("userData"),
    prefs: (() => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences(); return { contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration }; })() }));
  assert.equal(info.node, "24.21.0"); assert.equal(info.userData, userData);
  assert.deepEqual(info.prefs, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  for (const m of ["文件", "编辑", "视图", "工具", "帮助"]) assert.ok(info.menu.includes(m), m);
  const bridge = await win.evaluate(() => (window as unknown as { paiDesktop: { info(): Promise<unknown> } }).paiDesktop.info());
  const nodeInPage = await win.evaluate(() => typeof (globalThis as Record<string, unknown>).require);
  assert.equal(nodeInPage, "undefined", "no Node.js in the page");
  await win.evaluate(() => { location.href = "https://example.com/"; });
  await win.waitForTimeout(1500);
  assert.ok(win.url().startsWith(origin), "foreign navigation stays out of the app window");
  const st = await (await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(15_000) })).json() as { capabilities: { cad: unknown; blender: boolean } };
  if (!smoke) {
    assert.ok(st.capabilities.cad, "CadQuery configured (PAI_CADQUERY_PYTHON)");
    // C2 through the UI.
    await win.goto(`${origin}/#/requirements?new=1`);
    await win.getByRole("button", { name: "创建评审任务" }).click();
    await win.getByText("任务和验收要求已冻结为版本 1。").waitFor();
    await win.goto(`${origin}/#/design?lane=cad`);
    await win.getByRole("radio", { name: /轻量化/ }).check();
    await win.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
    await win.getByRole("heading", { name: "零件检查拒绝" }).waitFor({ timeout: 240_000 });
    const failed = await win.locator(".check-table tr.fail").allInnerTexts();
    assert.equal(failed.length, 1); assert.match(failed[0], /最小壁厚/);
    await mkdir(join(process.cwd(), ".state/evidence"), { recursive: true });
    await win.screenshot({ path: join(process.cwd(), ".state/evidence/desktop-c2.png") });
  }
  Object.assign(report, { result: "passed", app: { name: info.name, version: info.version, electron: info.electron, node: info.node, chrome: info.chrome }, menu: info.menu,
    security: { ...info.prefs, nodeInPage, foreignNavigationBlocked: true }, bridge, caseC2: smoke ? "skipped (smoke)" : { verdict: "rejected", failed: ["min-wall"] }, blender: st.capabilities.blender, smoke });
} finally {
  step("closing app");
  await Promise.race([appRun.close(), new Promise(r => setTimeout(r, 20_000))]);
  step("app closed");
  await new Promise(r => setTimeout(r, 1500));
  // The utility-process server must exit with the app: its loopback port no longer answers.
  report.serverStoppedWithApp = origin ? await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3000) }).then(() => false, () => true) : null;
  await rm(userData, { recursive: true, force: true });
}
// Fresh machine: no native tools configured -> the CAD lane offers the pinned installer instead of a dead end.
{
  const fresh = await mkdtemp(join(tmpdir(), "pai-desktop-fresh-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["PAI_CADQUERY_PYTHON", "PAI_BLENDER"].includes(k))) as Record<string, string>;
  step("fresh-install launch");
  const run = await electron.launch({ executablePath: exe, args: [], env: { ...env, PAI_DESKTOP_USER_DATA: fresh }, timeout: 60_000 });
  try {
    run.context().setDefaultTimeout(60_000);
    const w = await run.firstWindow();
    await w.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    const o = new URL(w.url()).origin;
    await w.goto(`${o}/#/requirements?new=1`);
    await w.getByRole("button", { name: "创建评审任务" }).click();
    await w.getByText("任务和验收要求已冻结为版本 1。").waitFor();
    await w.goto(`${o}/#/design?lane=cad`);
    await w.getByRole("button", { name: "安装 CadQuery 2.8（哈希锁定）" }).waitFor();
    await w.goto(`${o}/#/design?lane=scene`);
    await w.getByRole("button", { name: "安装 Blender 5.2.2 LTS（官方校验）" }).waitFor();
    const tools = await w.evaluate(() => (window as unknown as { paiDesktop: { info(): Promise<{ tools: unknown }> } }).paiDesktop.info().then(i => i.tools));
    step("fresh-install path checked");
    report.freshInstall = { cadInstallOffered: true, blenderInstallOffered: true, tools };
  } finally { await Promise.race([run.close(), new Promise(r => setTimeout(r, 20_000))]); await rm(fresh, { recursive: true, force: true }); }
}
await mkdir(join(process.cwd(), ".state/evidence"), { recursive: true });
await writeFile(join(process.cwd(), ".state/evidence/desktop-e2e.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
step("done");
// Electron helpers can outlive the test on headless CI; never let them keep this process alive.
process.exit(0);
