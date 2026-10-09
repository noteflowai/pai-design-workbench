import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** What is running: package version, source commit and (hosted) the release archive digest. */
export interface BuildInfo {
  version: string;
  /** Full source commit, or null when unknown (dirty checkout, no git, unrecorded package). */
  commit: string | null;
  /** "packaged": read from the release's .build-info.json; "checkout": asked git in a local working tree. */
  source: "packaged" | "checkout" | "unknown";
  /** Checkout only: tracked source files differ from the commit. */
  dirty?: boolean;
  packagedAt?: string;
  /** Hosted only: SHA-256 of the release archive (the /opt/pai/releases/<digest> directory name). */
  releaseDigest?: string;
}

const COMMIT = /^[a-f0-9]{40}$/;

export function buildInfo(repository: string): BuildInfo {
  const version = (() => { try { return String(JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).version); } catch { return "unknown"; } })();
  const digest = basename(repository);
  const releaseDigest = /^[a-f0-9]{64}$/.test(digest) && basename(dirname(repository)) === "releases" ? digest : undefined;
  // A packaged release records its build (tools/package_release.py); older packages only have .source-commit.
  const packaged = (() => { try { return JSON.parse(readFileSync(join(repository, ".build-info.json"), "utf8")) as Record<string, unknown>; } catch { return undefined; } })();
  const recorded = (() => { try { return readFileSync(join(repository, ".source-commit"), "utf8").trim(); } catch { return ""; } })();
  if (packaged || COMMIT.test(recorded)) {
    const commit = typeof packaged?.sourceCommit === "string" && COMMIT.test(packaged.sourceCommit) ? packaged.sourceCommit : COMMIT.test(recorded) ? recorded : null;
    return { version, commit, source: "packaged", ...(typeof packaged?.packagedAt === "string" ? { packagedAt: packaged.packagedAt } : {}), ...(releaseDigest ? { releaseDigest } : {}) };
  }
  try {
    // Only this repository's own commit; never one of a surrounding repository.
    const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (git("rev-parse", "--show-toplevel") !== repository) return { version, commit: null, source: "unknown" };
    const commit = git("rev-parse", "HEAD");
    return { version, commit: COMMIT.test(commit) ? commit : null, source: "checkout", dirty: git("status", "--porcelain", "--untracked-files=no").length > 0 };
  } catch { return { version, commit: null, source: "unknown" }; }
}
