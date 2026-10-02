// PAI Design Workbench desktop shell (Electron 44 / Node 24.21, the same runtime the server is pinned to).
// The shell starts the unmodified workbench server in an Electron utility process on a loopback port, then
// shows it in a hardened window. No server code is forked or duplicated; native tools stay external programs.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, utilityProcess } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicDependencyPins, pinnedDependency, nativeInstallSupported, isWorkbenchUrl } from "./runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(here);                          // resources/app (dist, web-dist, native, data, tools)
const resources = app.isPackaged ? process.resourcesPath : join(appDir, ".state");
const deps = app.isPackaged ? join(resources, "deps") : join(appDir, ".state/deps");
const dependencyPins = publicDependencyPins(join(appDir, "tools/runtime-pins.json"));
const canInstall = nativeInstallSupported(process.platform, process.arch);
// PAI_DESKTOP_USER_DATA isolates a run (tests, portable use) from the default per-user data directory.
if (process.env.PAI_DESKTOP_USER_DATA) app.setPath("userData", process.env.PAI_DESKTOP_USER_DATA);
const userData = app.getPath("userData");
const statePath = join(userData, "state"), toolsDir = join(userData, "tools"), envFile = join(userData, "tools.env");
const settingsFile = join(userData, "settings.json"), logFile = join(userData, "server.log");
const PRODUCT = "PAI Design Workbench";

if (!app.requestSingleInstanceLock()) app.quit();
mkdirSync(statePath, { recursive: true, mode: 0o700 });

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
const settings = () => readJson(settingsFile, {});
const saveSettings = patch => writeFileSync(settingsFile, JSON.stringify({ ...settings(), ...patch }, null, 2), { mode: 0o600 });
// Installer output (tools/setup_*.py) lands in tools.env; explicit choices in settings win; the environment wins over both.
const envFromFile = () => Object.fromEntries((existsSync(envFile) ? readFileSync(envFile, "utf8") : "").split("\n")
  .map(l => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2]]));
// Pinned upstream checkouts (Robot Reel records, EvalArc, Radar) ship as resources/deps/<name>-<commit>.
const pinned = name => pinnedDependency(deps, dependencyPins, name);

function toolEnv() {
  const s = settings(), installed = envFromFile();
  return {
    PAI_BLENDER: process.env.PAI_BLENDER ?? s.blender ?? installed.PAI_BLENDER,
    PAI_CADQUERY_PYTHON: process.env.PAI_CADQUERY_PYTHON ?? s.cadquery ?? installed.PAI_CADQUERY_PYTHON,
  };
}

const freePort = () => new Promise((ok, fail) => { const s = createServer().once("error", fail).listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
let server, origin, win, quitting = false;

async function startServer() {
  const port = await freePort();
  const tools = toolEnv();
  const env = { ...process.env, PORT: String(port), PAI_LISTEN_HOST: "127.0.0.1", PAI_STATE: statePath, PAI_WEB: join(appDir, "web-dist"),
    PAI_ROBOT_ROOT: pinned("robot-reel"), PAI_STRESS_SOURCE: join(pinned("robot-reel"), "docs/stress"), PAI_EVALARC_ROOT: pinned("evalarc"),
    PAI_RADAR_FILE: join(pinned("physical-ai-radar"), "radar/latest.json"), PAI_DESKTOP: "1", NODE_NO_WARNINGS: "1" };
  for (const [k, v] of Object.entries(tools)) if (v) env[k] = v; else delete env[k];
  delete env.PAI_PUBLIC_ORIGIN; // the desktop server is loopback-only and never authenticates through an ALB
  const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  log.write(`\n--- ${new Date().toISOString()} start on 127.0.0.1:${port} (blender ${Boolean(tools.PAI_BLENDER)}, cadquery ${Boolean(tools.PAI_CADQUERY_PYTHON)})\n`);
  const child = utilityProcess.fork(join(appDir, "dist/src/server.js"), [], { env, cwd: appDir, stdio: "pipe", serviceName: `${PRODUCT} server` });
  server = child;
  child.stdout?.on("data", d => log.write(d)); child.stderr?.on("data", d => log.write(d));
  child.once("exit", code => {
    log.write(`--- server exited ${code}\n`);
    if (server === child) {
      server = undefined;
      if (!quitting) dialog.showErrorBox(PRODUCT, `本地工作台服务意外退出（代码 ${code}）。日志：${logFile}`);
    }
  });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) return origin; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`工作台服务 30 秒内未就绪；日志：${logFile}`);
}
async function stopServer() {
  if (!server) return;
  const s = server; server = undefined;
  await new Promise(ok => { s.once("exit", ok); s.kill(); setTimeout(ok, 5000); });
}
async function restartServer() { await stopServer(); await startServer(); await win?.loadURL(`${origin}/${hashOf(win)}`); }
const hashOf = w => { try { return new URL(w.webContents.getURL()).hash; } catch { return ""; } };

function createWindow() {
  const bounds = settings().bounds ?? { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...bounds, minWidth: 1024, minHeight: 680, show: false, title: PRODUCT, backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1a1e" : "#f4f6f5",
    icon: join(here, "icon.png"),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", () => saveSettings({ bounds: win.getBounds() }));
  // Only the local workbench is ever loaded in the window; everything else opens in the system browser.
  win.webContents.on("will-navigate", (e, url) => { if (!isWorkbenchUrl(url, origin)) { e.preventDefault(); openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (isWorkbenchUrl(url, origin)) return { action: "allow" }; openExternal(url); return { action: "deny" }; });
  return win;
}
const openExternal = url => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); };
const go = hash => win?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);

async function chooseTool(kind) {
  const r = await dialog.showOpenDialog(win, { title: kind === "blender" ? "选择 Blender 可执行文件（5.2 LTS）" : "选择 CadQuery 2.8 的 Python 解释器",
    properties: ["openFile", "showHiddenFiles"] });
  if (r.canceled || !r.filePaths[0]) return;
  saveSettings({ [kind]: r.filePaths[0] });
  await restartServer();
}
function installTool(kind) {
  if (!canInstall) throw new Error("Automatic native-tool installation is supported on Linux x64 only. Select an existing executable in the Tools menu.");
  const script = join(appDir, "tools", kind === "blender" ? "setup_native_tools.py" : "setup_cadquery.py");
  const python = kind === "cadquery" ? "python3.12" : "python3";
  const args = [script];
  const child = spawn(python, args, { cwd: userData, env: { ...process.env, PAI_TOOLS_DIR: toolsDir, PAI_ENV_FILE: envFile } });
  let err = "";
  child.stderr.on("data", d => { err = (err + d).slice(-2000); });
  win?.setProgressBar(2);
  child.on("error", e => { win?.setProgressBar(-1); dialog.showErrorBox(PRODUCT, `无法启动安装程序（${python}）：${e.message}`); });
  child.on("exit", async code => {
    win?.setProgressBar(-1);
    if (code === 0) { await restartServer(); void dialog.showMessageBox(win, { message: kind === "blender" ? "Blender 5.2.2 LTS 已安装并通过官方 SHA-256 校验。" : "CadQuery 2.8.0 已按哈希锁定安装并通过自检。" }); }
    else dialog.showErrorBox(PRODUCT, `安装失败（代码 ${code}）。\n${err.trim().split("\n").slice(-6).join("\n")}`);
  });
}

function buildMenu() {
  const mac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "文件", submenu: [
      { label: "新建评审任务", accelerator: "CmdOrCtrl+N", click: () => go("#/requirements?new=1") },
      { label: "打开数据目录", click: () => shell.openPath(userData) },
      { label: "打开服务日志", click: () => shell.openPath(logFile) },
      { type: "separator" }, mac ? { role: "close" } : { role: "quit", label: "退出" },
    ] },
    { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" }] },
    { label: "视图", submenu: [
      { label: "命令面板", accelerator: "CmdOrCtrl+K", click: () => win?.webContents.sendInputEvent({ type: "keyDown", keyCode: "K", modifiers: [mac ? "meta" : "control"] }) },
      { label: "AI 助手", accelerator: "CmdOrCtrl+J", click: () => win?.webContents.executeJavaScript("window.dispatchEvent(new Event('pai-toggle-assistant'))") },
      { type: "separator" },
      { label: "外观", submenu: ["system", "light", "dark"].map(t => ({ label: { system: "跟随系统", light: "浅色", dark: "深色" }[t], type: "radio", checked: (settings().theme ?? "system") === t,
        click: () => { nativeTheme.themeSource = t; saveSettings({ theme: t }); } })) },
      { type: "separator" }, { role: "reload", label: "重新加载" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
      { role: "togglefullscreen", label: "全屏" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
    ] },
    { label: "工具", submenu: [
      { label: "安装 Blender 5.2.2 LTS（官方校验）", enabled: canInstall, click: () => installTool("blender") },
      { label: "安装 CadQuery 2.8（哈希锁定）", enabled: canInstall, click: () => installTool("cadquery") },
      { type: "separator" },
      { label: "选择 Blender 可执行文件…", click: () => chooseTool("blender") },
      { label: "选择 CadQuery Python…", click: () => chooseTool("cadquery") },
      { label: "清除自定义工具路径", click: async () => { saveSettings({ blender: undefined, cadquery: undefined }); await restartServer(); } },
      { type: "separator" }, { label: "重启本地服务", click: () => restartServer() },
    ] },
    { label: "帮助", submenu: [
      { label: "使用说明", click: () => openExternal("https://github.com/noteflowai/pai-design-workbench#readme") },
      { label: "工业设计典型用例", click: () => openExternal("https://github.com/noteflowai/pai-design-workbench/blob/main/docs/INDUSTRIAL_TEST_CASES.md") },
      { label: `关于 ${PRODUCT}`, click: () => dialog.showMessageBox(win, { title: PRODUCT, message: `${PRODUCT} ${app.getVersion()}`,
        detail: `Electron ${process.versions.electron} · Node ${process.versions.node} · Chromium ${process.versions.chrome}\n数据目录：${userData}` }) },
    ] },
  ]));
}

const trustedSender = event => {
  if (event.sender !== win?.webContents || !isWorkbenchUrl(event.senderFrame?.url, origin)) {
    throw new Error("Desktop bridge requires the local workbench window");
  }
};
ipcMain.handle("pai:desktop", event => {
  trustedSender(event);
  return { version: app.getVersion(), platform: process.platform, arch: process.arch,
    installers: { blender: canInstall, cadquery: canInstall },
    tools: Object.fromEntries(Object.entries(toolEnv()).map(([k, v]) => [k, Boolean(v)])) };
});
ipcMain.handle("pai:install-tool", (event, kind) => {
  trustedSender(event);
  if (kind !== "blender" && kind !== "cadquery") throw new Error("Unknown native tool");
  installTool(kind);
});

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", e => { if (server) { e.preventDefault(); void stopServer().then(() => app.quit()); } });
app.on("window-all-closed", () => app.quit());
app.whenReady().then(async () => {
  nativeTheme.themeSource = settings().theme ?? "system";
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  buildMenu();
  createWindow();
  await win.loadFile(join(here, "splash.html"));
  try { await startServer(); await win.loadURL(`${origin}/`); }
  catch (e) { dialog.showErrorBox(PRODUCT, String(e?.message ?? e)); app.quit(); }
});
