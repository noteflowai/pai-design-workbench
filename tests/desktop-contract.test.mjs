import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stageDesktop } from "../tools/package_desktop.mjs";
import { isWorkbenchUrl, nativeInstallSupported, pinnedDependency, publicDependencyPins } from "../desktop/runtime.mjs";
import { packagedExecutable } from "../scripts/desktop-executable.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const names = ["robot-reel", "evalarc", "physical-ai-radar"];
const text = file => readFileSync(file, "utf8");
const put = (file, value) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, value); };
const installFixture = app => put(join(app, "node_modules/fixture.txt"), "production-installed");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pai desktop 日本語 % "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pins = {};
  for (const name of names) {
    const source = join(dir, ".state/deps", name);
    mkdirSync(source, { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
    git("init", "-q");
    put(join(source, ".gitignore"), "__pycache__/\n.env\n");
    put(join(source, "record.txt"), name);
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Pinned fixture");
    pins[name] = git("rev-parse", "HEAD");
    put(join(source, "__pycache__/ignored.pyc"), "not-shipped");
    put(join(source, ".env"), "fixture-private-cache-not-shipped");
    renameSync(source, join(dir, ".state/deps", `${name}-${pins[name].slice(0, 12)}`));
  }
  for (const file of ["dist/src/server.js", "web-dist/index.html", "native/cadquery-requirements.txt",
    "data/record.json", "desktop/build/icon.png", "desktop/main.mjs", "desktop/preload.cjs", "desktop/splash.html",
    "tools/setup_native_tools.py", "tools/setup_cadquery.py"]) put(join(dir, file), "fixture");
  cpSync(join(repository, "desktop/runtime.mjs"), join(dir, "desktop/runtime.mjs"));
  put(join(dir, "tools/runtime-pins.json"), JSON.stringify({ schema: "pai-runtime-pins-1", publicDependencies: pins }));
  put(join(dir, "package.json"), JSON.stringify({ name: "pai-design-workbench", version: "0.8.0", dependencies: {} }));
  put(join(dir, "package-lock.json"), JSON.stringify({ name: "pai-design-workbench", version: "0.8.0", lockfileVersion: 3,
    packages: { "": { name: "pai-design-workbench", version: "0.8.0", dependencies: {} } } }));
  for (const file of ["app/previous.txt", "deps/previous.txt", "dist/previous-installer.txt"]) {
    put(join(dir, ".state/desktop", file), "previous-working-release");
  }
  return { dir, pins, out: join(dir, ".state/desktop") };
}

test("real CLI staging decodes spaces, Unicode and percent signs, retains installers and ships only registered commits", t => {
  const { dir, pins, out } = fixture(t);
  // Execute the real entry point, including fileURLToPath and npm ci, in a clean path on each OS.
  cpSync(join(repository, "tools/package_desktop.mjs"), join(dir, "tools/package_desktop.mjs"));
  put(join(dir, ".state/deps/robot-reel-ffffffffffff/private.txt"), "stale-cache");
  execFileSync(process.execPath, [join(dir, "tools/package_desktop.mjs")], { cwd: tmpdir(), stdio: "pipe" });
  assert.equal(text(join(out, "dist/previous-installer.txt")), "previous-working-release");
  assert.deepEqual(readdirSync(join(out, "deps")).sort(), names.map(name => `${name}-${pins[name].slice(0, 12)}`).sort());
  for (const name of names) {
    const root = pinnedDependency(join(out, "deps"), publicDependencyPins(join(out, "app/tools/runtime-pins.json")), name);
    assert.equal(text(join(root, "record.txt")), name);
    assert.equal(existsSync(join(root, ".git")), false);
    assert.equal(existsSync(join(root, "__pycache__")), false);
    assert.equal(existsSync(join(root, ".env")), false);
  }
  assert.equal(existsSync(join(out, "app/package-lock.json")), false);
  assert.equal(text(join(out, "app/desktop/runtime.mjs")), text(join(repository, "desktop/runtime.mjs")));
});

test("missing and dirty pinned inputs cannot replace a working stage or call the installer", t => {
  const { dir, pins, out } = fixture(t);
  const source = join(dir, ".state/deps", `robot-reel-${pins["robot-reel"].slice(0, 12)}`);
  put(join(source, "record.txt"), "modified-after-pin");
  let installs = 0;
  const install = () => { installs++; };
  assert.throws(() => stageDesktop(dir, { install }), /Pinned dependency changed/);
  assert.equal(installs, 0);
  assert.equal(text(join(out, "app/previous.txt")), "previous-working-release");
  rmSync(join(dir, "desktop/build/icon.png"));
  assert.throws(() => stageDesktop(dir, { install }), /Missing desktop/);
  assert.equal(installs, 0);
  assert.equal(text(join(out, "deps/previous.txt")), "previous-working-release");
});

test("CLI reached through a directory alias still stages instead of silently returning", t => {
  const { dir, out, pins } = fixture(t);
  cpSync(join(repository, "tools/package_desktop.mjs"), join(dir, "tools/package_desktop.mjs"));
  const alias = join(dir, "directory alias");
  symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  execFileSync(process.execPath, [join(alias, "tools/package_desktop.mjs")], { cwd: tmpdir(), stdio: "pipe" });
  assert.equal(existsSync(join(out, "app/previous.txt")), false);
  assert.equal(text(join(out, "deps", `robot-reel-${pins["robot-reel"].slice(0, 12)}`, "record.txt")), "robot-reel");
  assert.equal(text(join(out, "dist/previous-installer.txt")), "previous-working-release");
});

test("production install failure preserves the previous app, dependency pair and installer bytes", t => {
  const { dir, out } = fixture(t);
  assert.throws(() => stageDesktop(dir, { install: () => { throw new Error("registry unavailable"); } }), /registry unavailable/);
  for (const file of ["app/previous.txt", "deps/previous.txt", "dist/previous-installer.txt"]) {
    assert.equal(text(join(out, file)), "previous-working-release");
  }
  assert.equal(readdirSync(out).some(name => name.startsWith(".prepare-")), false);
  stageDesktop(dir, { install: installFixture });
  assert.equal(text(join(out, "app/node_modules/fixture.txt")), "production-installed");
  assert.equal(text(join(out, "dist/previous-installer.txt")), "previous-working-release");
});

test("missing registered commit never falls back to a lexicographically newer cache", t => {
  const { dir, pins } = fixture(t);
  const deps = join(dir, ".state/deps");
  rmSync(join(deps, `robot-reel-${pins["robot-reel"].slice(0, 12)}`), { recursive: true });
  mkdirSync(join(deps, "robot-reel-ffffffffffff"));
  assert.throws(() => pinnedDependency(deps, pins, "robot-reel"), /Missing pinned dependency/);
  assert.throws(() => pinnedDependency(deps, pins, "unregistered"), /Unregistered/);
});

test("local navigation rejects credential-prefix bypasses, other ports and schemes", () => {
  const origin = "http://127.0.0.1:4317";
  assert.equal(isWorkbenchUrl(`${origin}/#/design`, origin), true);
  for (const url of [`${origin}@example.com/`, "http://127.0.0.1:4318/", "https://127.0.0.1:4317/",
    "file:///tmp/page.html", "javascript:alert(1)", "not a URL"]) {
    assert.equal(isWorkbenchUrl(url, origin), false, url);
  }
  assert.equal(isWorkbenchUrl(origin, undefined), false);
});

test("automatic installers advertise only the platform targeted by the pinned wheels and scripts", () => {
  assert.equal(nativeInstallSupported("linux", "x64"), true);
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "arm64"]]) {
    assert.equal(nativeInstallSupported(platform, arch), false);
  }
});

test("packaged executable uses the configured name for macOS bundles and Windows/Linux binaries", t => {
  const root = mkdtempSync(join(tmpdir(), "pai packages "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = { productName: "Display Name", executableName: "pai-workbench" };
  for (const [platform, arch, path] of [
    ["darwin", "arm64", "mac-arm64/pai-workbench.app/Contents/MacOS/pai-workbench"],
    ["darwin", "x64", "mac/pai-workbench.app/Contents/MacOS/pai-workbench"],
    ["win32", "x64", "win-unpacked/pai-workbench.exe"],
    ["linux", "x64", "linux-unpacked/pai-workbench"],
  ]) {
    const expected = join(root, path);
    put(expected, "packaged-binary");
    assert.equal(packagedExecutable(root, build, platform, arch), expected);
  }
  assert.throws(() => packagedExecutable(root, { ...build, executableName: "missing" }, "darwin", "arm64"), /Missing packaged executable/);
});
