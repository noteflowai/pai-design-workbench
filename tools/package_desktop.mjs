// Stage one verified desktop input set. Existing installers and a working stage survive failed preparation.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicDependencyPins, pinnedDependency } from "../desktop/runtime.mjs";

const desktopFiles = ["main.mjs", "preload.cjs", "runtime.mjs", "splash.html"];
const toolFiles = ["setup_cadquery.py", "setup_native_tools.py", "runtime-pins.json"];
const installProduction = app => execFileSync("npm", [
  "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
], { cwd: app, stdio: "inherit", shell: process.platform === "win32" });

export function stageDesktop(root, { install = installProduction } = {}) {
  root = resolve(root);
  const out = join(root, ".state/desktop");
  const required = [
    "package.json", "package-lock.json", "dist/src/server.js", "web-dist/index.html", "desktop/build/icon.png",
    "native/cadquery-requirements.txt", "data",
    ...desktopFiles.map(file => `desktop/${file}`), ...toolFiles.map(file => `tools/${file}`),
  ];
  for (const need of required) {
    if (!existsSync(join(root, need))) throw new Error(`Missing ${need}; build and set up the pinned desktop inputs first`);
  }
  const pins = publicDependencyPins(join(root, "tools/runtime-pins.json"));
  const sources = Object.entries(pins).map(([name, pin]) => {
    const dir = pinnedDependency(join(root, ".state/deps"), pins, name);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
    if (head !== pin || dirty) throw new Error(`Pinned dependency changed: ${name}; preserve and reconcile it`);
    // Only files owned by the pinned Git tree, never ignored credentials, caches or .git metadata.
    // Sparse Robot Reel checkouts intentionally omit unrelated recordings.
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" })
      .split("\0").filter(file => file && existsSync(join(dir, file)));
    for (const file of files) {
      const location = relative(realpathSync(dir), realpathSync(join(dir, file)));
      if (isAbsolute(location) || location === ".." || location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error(`Pinned dependency file escapes its root: ${name}/${file}`);
      }
    }
    return [name, dir, files];
  });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  mkdirSync(out, { recursive: true });
  const prepared = mkdtempSync(join(out, ".prepare-"));
  const app = join(prepared, "app"), deps = join(prepared, "deps");
  let keepPrepared = false;
  try {
    mkdirSync(app);
    for (const dir of ["dist", "web-dist", "native", "data"]) {
      cpSync(join(root, dir), join(app, dir), { recursive: true, filter: path => !path.includes("__pycache__") });
    }
    for (const [dir, files] of [["tools", toolFiles], ["desktop", desktopFiles]]) {
      mkdirSync(join(app, dir));
      for (const file of files) cpSync(join(root, dir, file), join(app, dir, file));
    }
    cpSync(join(root, "desktop/build/icon.png"), join(app, "desktop/icon.png"));
    writeFileSync(join(app, "package.json"), JSON.stringify({
      name: pkg.name, productName: "PAI Design Workbench", version: pkg.version,
      description: "PAI Design Workbench desktop", author: "NoteFlow AI <admin@noteflowai.com>",
      license: pkg.license ?? "MIT", type: "module", main: "desktop/main.mjs",
      homepage: "https://github.com/noteflowai/pai-design-workbench", desktopName: "pai-workbench.desktop",
      dependencies: pkg.dependencies,
    }, null, 2));
    cpSync(join(root, "package-lock.json"), join(app, "package-lock.json"));
    install(app);
    rmSync(join(app, "package-lock.json"));
    mkdirSync(deps);
    for (const [, dir, files] of sources) {
      const destination = join(deps, basename(dir));
      mkdirSync(destination);
      for (const file of files) {
        const target = join(destination, file);
        mkdirSync(join(target, ".."), { recursive: true });
        cpSync(join(dir, file), target);
      }
    }
    // Only replace prepared application inputs. Never delete previously built installers in dist/.
    const moves = [];
    try {
      for (const name of ["app", "deps"]) {
        const target = join(out, name), backup = join(prepared, `${name}-previous`);
        const hadPrevious = existsSync(target);
        if (hadPrevious) renameSync(target, backup);
        const move = { target, backup, hadPrevious, installed: false };
        moves.push(move);
        renameSync(join(prepared, name), target);
        move.installed = true;
      }
    } catch (error) {
      const failures = [];
      for (const move of moves.reverse()) {
        try {
          if (move.installed) rmSync(move.target, { recursive: true, force: true });
          if (move.hadPrevious) renameSync(move.backup, move.target);
        } catch (rollback) { failures.push(rollback); }
      }
      if (failures.length) {
        keepPrepared = true;
        throw new AggregateError([error, ...failures], `Stage replacement needs reconciliation; backups retained in ${prepared}`);
      }
      throw error;
    }
    return { app: join(out, "app"), deps: Object.entries(pins).map(([name, pin]) => `${name}-${pin.slice(0, 12)}`), version: pkg.version };
  } finally {
    if (!keepPrepared) rmSync(prepared, { recursive: true, force: true });
  }
}

if (process.argv[1] && existsSync(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(stageDesktop(fileURLToPath(new URL("..", import.meta.url)))));
}
