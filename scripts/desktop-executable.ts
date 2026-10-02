import { existsSync } from "node:fs";
import { basename, join } from "node:path";

type DesktopBuild = {
  productName: string;
  executableName?: string;
  mac?: { executableName?: string };
  win?: { executableName?: string };
  linux?: { executableName?: string };
};

/** electron-builder names bundles/binaries from executableName, not the display name. */
export function packagedExecutable(base: string, build: DesktopBuild, platform: string = process.platform, arch: string = process.arch): string {
  const options = platform === "darwin" ? build.mac : platform === "win32" ? build.win : build.linux;
  const name = options?.executableName ?? build.executableName ?? build.productName;
  if (!name || basename(name) !== name) throw new Error("Invalid desktop executable name");
  const path = platform === "darwin"
    ? join(base, arch === "arm64" ? "mac-arm64" : "mac", `${name}.app`, "Contents", "MacOS", name)
    : join(base, platform === "win32" ? "win-unpacked" : "linux-unpacked", name + (platform === "win32" ? ".exe" : ""));
  if (!existsSync(path)) throw new Error(`Missing packaged executable: ${path}`);
  return path;
}
