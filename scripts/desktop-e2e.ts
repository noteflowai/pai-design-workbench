import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { packagedExecutable } from "./desktop-executable.js";

process.on("uncaughtExceptionMonitor", error => { console.error(error.stack); });
const smoke = process.argv.includes("--smoke");
function executable() {
  if (process.env.PAI_DESKTOP_EXE) return process.env.PAI_DESKTOP_EXE;
  const base = join(process.cwd(), ".state/desktop/dist");
  const pkg = JSON.parse(readFileSync("desktop/package.json", "utf8"));
  return packagedExecutable(base, pkg.build);
}
let completedChecks = 0;
const report: Record<string, unknown> = { schema: "pai-desktop-e2e-2", checkedAt: new Date().toISOString(), smoke, result: "incomplete" };
const evidence = join(process.cwd(), ".state/evidence/desktop-e2e.json");
async function save() {
  await mkdir(join(process.cwd(), ".state/evidence"), { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2));
}
let exe: string;
try {
  exe = executable();
  report.executable = exe;
  await save();
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  await save();
  throw error;
}
// Cleanup is bounded and can terminate only the Electron process launched by this test.
async function ownApp(t: TestContext, fresh = false): Promise<{ app: ElectronApplication; userData: string }> {
  const userData = await mkdtemp(join(tmpdir(), "pai desktop 日本語 % "));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !fresh || !["PAI_CADQUERY_PYTHON", "PAI_BLENDER"].includes(k))) as Record<string, string>;
  let app: ElectronApplication;
  try {
    app = await electron.launch({ executablePath: exe, args: [], env: { ...env, PAI_DESKTOP_USER_DATA: userData }, timeout: 60_000 });
  } catch (error) {
    await rm(userData, { recursive: true, force: true });
    await save();
    throw error;
  }
  app.context().setDefaultTimeout(30_000);
  app.context().setDefaultNavigationTimeout(30_000);
  // Cache the owned child before closing Playwright's channel. node:test also aborts
  // its signal on successful completion, when app.process() is no longer available.
  const child = app.process();
  const abort = () => { child.kill(); };
  t.signal.addEventListener("abort", abort, { once: true });
  t.after(async () => {
    const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
    deadline.unref();
    try { await app.close(); await rm(userData, { recursive: true, force: true }); }
    catch (error) { report.cleanupFailed = true; throw error; }
    finally { clearTimeout(deadline); t.signal.removeEventListener("abort", abort); await save(); }
  });
  return { app, userData };
}

await test("packaged app: startup, local bridge, navigation isolation and shutdown", { timeout: smoke ? 180_000 : 450_000 }, async t => {
  console.log("desktop phase: launch");
  const t0 = Date.now(), { app, userData } = await ownApp(t);
  const win = await app.firstWindow({ timeout: 60_000 });
  await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  const origin = new URL(win.url()).origin;
  report.startupSeconds = Math.round((Date.now() - t0) / 100) / 10;
  const info = await app.evaluate(({ app, Menu, BrowserWindow }) => ({ name: app.getName(), version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, menu: Menu.getApplicationMenu()!.items.map((i: { label: string }) => i.label), userData: app.getPath("userData"),
    prefs: (() => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences(); return { contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration }; })() }));
  assert.equal(info.node, "24.21.0"); assert.equal(realpathSync(info.userData), realpathSync(userData));
  assert.deepEqual(info.prefs, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  for (const menu of ["文件", "编辑", "视图", "工具", "帮助"]) assert.ok(info.menu.includes(menu), menu);
  const bridge = await win.evaluate(() => (window as unknown as { paiDesktop: { info(): Promise<unknown> } }).paiDesktop.info());
  const nodeInPage = await win.evaluate(() => typeof (globalThis as Record<string, unknown>).require);
  assert.equal(nodeInPage, "undefined", "no Node.js in the page");
  // Assert the real navigation handlers without launching an external browser/xdg-open on the runner.
  await app.evaluate(({ shell }) => { shell.openExternal = async () => undefined; });
  console.log("desktop phase: navigation isolation");
  for (const target of ["https://example.com/", `${origin}@example.com/`]) {
    await win.evaluate(url => { location.href = url; }, target);
    await win.waitForTimeout(500);
    assert.equal(new URL(win.url()).origin, origin, "foreign navigation stays out of the app window");
  }
  const st = await (await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(5000) })).json() as { capabilities: { cad: unknown; blender: boolean } };
  if (!smoke) {
    console.log("desktop phase: native case C2");
    assert.ok(st.capabilities.cad, "CadQuery configured (PAI_CADQUERY_PYTHON)");
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
  Object.assign(report, { app: { name: info.name, version: info.version, electron: info.electron, node: info.node, chrome: info.chrome }, menu: info.menu,
    security: { ...info.prefs, nodeInPage, foreignNavigationBlocked: true }, bridge, caseC2: smoke ? "skipped (smoke)" : { verdict: "rejected", failed: ["min-wall"] }, blender: st.capabilities.blender });
  console.log("desktop phase: shutdown");
  await app.close();
  await new Promise(r => setTimeout(r, 500));
  report.serverStoppedWithApp = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3000) }).then(() => false, () => true);
  assert.equal(report.serverStoppedWithApp, true, "the app must stop its own server");
  completedChecks++;
  await save();
});

await test("fresh install: platform capabilities and supported tool choices", { timeout: 180_000 }, async t => {
  console.log("desktop phase: fresh install");
  const { app } = await ownApp(t, true);
  const win = await app.firstWindow({ timeout: 60_000 });
  await win.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  const origin = new URL(win.url()).origin;
  const nativeInstaller = process.platform === "linux" && process.arch === "x64";
  const info = await win.evaluate(() => (window as unknown as { paiDesktop: {
    info(): Promise<{ installers: { cadquery: boolean; blender: boolean }; tools: unknown }>;
  } }).paiDesktop.info());
  assert.deepEqual(info.installers, { cadquery: nativeInstaller, blender: nativeInstaller });
  if (!nativeInstaller) {
    const refused = await win.evaluate(() => (window as unknown as { paiDesktop: {
      installTool(kind: string): Promise<void>;
    } }).paiDesktop.installTool("cadquery").then(() => false, () => true));
    assert.equal(refused, true, "unsupported installer requests must fail before spawning");
  }
  await win.goto(`${origin}/#/requirements?new=1`);
  await win.getByRole("button", { name: "创建评审任务" }).click();
  await win.getByText("任务和验收要求已冻结为版本 1。").waitFor();
  for (const [lane, kind, button] of [["cad", "CadQuery Python", "安装 CadQuery 2.8（哈希锁定）"], ["scene", "Blender 可执行文件", "安装 Blender 5.2.2 LTS（官方校验）"]]) {
    await win.goto(`${origin}/#/design?lane=${lane}`);
    if (nativeInstaller) await win.getByRole("button", { name: button }).waitFor();
    else await win.getByText(`此平台请在“工具”菜单选择已有的 ${kind}。自动安装目前支持 Linux x64。`, { exact: true }).waitFor();
  }
  report.freshInstall = { cadInstallOffered: nativeInstaller, blenderInstallOffered: nativeInstaller, tools: info.tools };
  completedChecks++;
  await save();
});
report.result = completedChecks === 2 && !report.cleanupFailed && !process.exitCode ? "passed" : "failed";
await save();
console.log(JSON.stringify(report, null, 2));
