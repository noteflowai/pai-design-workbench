// Stage the desktop app for electron-builder: the built workbench, production node_modules, native scripts,
// bundled Factory Twin data and the pinned upstream checkouts (without .git). Nothing is rewritten.
//   npm run build && node tools/package_desktop.mjs && (cd desktop && npm ci && npm run dist:linux)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, ".state/desktop"), app = join(out, "app"), deps = join(out, "deps");
for (const need of ["dist/src/server.js", "web-dist/index.html", "desktop/build/icon.png"]) {
  if (!existsSync(join(root, need))) throw new Error(`missing ${need}: run npm run build and node tools/make_icon.mjs`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const dir of ["dist", "web-dist", "native", "data"]) cpSync(join(root, dir), join(app, dir), { recursive: true, filter: s => !s.includes("__pycache__") });
mkdirSync(join(app, "tools"));
for (const f of ["setup_cadquery.py", "setup_native_tools.py", "runtime-pins.json"]) cpSync(join(root, "tools", f), join(app, "tools", f));
mkdirSync(join(app, "desktop"));
for (const f of ["main.mjs", "preload.cjs", "splash.html"]) cpSync(join(root, "desktop", f), join(app, "desktop", f));
cpSync(join(root, "desktop/build/icon.png"), join(app, "desktop/icon.png"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "pai-design-workbench", productName: "PAI Design Workbench", version: pkg.version,
  description: "PAI Design Workbench desktop", author: "NoteFlow AI <admin@noteflowai.com>", license: pkg.license ?? "MIT", type: "module",
  main: "desktop/main.mjs", homepage: "https://github.com/noteflowai/pai-design-workbench", desktopName: "pai-workbench.desktop",
  dependencies: pkg.dependencies }, null, 2));
cpSync(join(root, "package-lock.json"), join(app, "package-lock.json"));
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app, stdio: "inherit", shell: process.platform === "win32" });
rmSync(join(app, "package-lock.json"));
mkdirSync(deps);
for (const name of readdirSync(join(root, ".state/deps")).filter(n => /-[0-9a-f]{12}$/.test(n))) {
  cpSync(join(root, ".state/deps", name), join(deps, name), { recursive: true, filter: s => !/[\\/]\.git([\\/]|$)|__pycache__/.test(s) });
}
console.log(JSON.stringify({ app, deps: readdirSync(deps), version: pkg.version }));
