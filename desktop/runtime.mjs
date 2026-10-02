import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function publicDependencyPins(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  const pins = value.publicDependencies;
  const names = ["robot-reel", "evalarc", "physical-ai-radar"];
  if (value.schema !== "pai-runtime-pins-1" || !pins || Object.keys(pins).length !== names.length
      || names.some(name => !/^[a-f0-9]{40}$/.test(pins[name] ?? ""))) {
    throw new Error("Missing or invalid pinned public dependencies");
  }
  return Object.fromEntries(names.map(name => [name, pins[name]]));
}

export function pinnedDependency(dir, pins, name) {
  if (!Object.hasOwn(pins, name)) throw new Error(`Unregistered dependency: ${name}`);
  const root = join(dir, `${name}-${pins[name].slice(0, 12)}`);
  if (!existsSync(root)) throw new Error(`Missing pinned dependency: ${name}@${pins[name]}`);
  return root;
}

export function nativeInstallSupported(platform, arch) {
  // Both existing installers and the hash-locked CadQuery wheels target this platform.
  return platform === "linux" && arch === "x64";
}

export function isWorkbenchUrl(raw, origin) {
  if (!origin) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && !url.username && !url.password && url.origin === origin;
  } catch {
    return false;
  }
}
