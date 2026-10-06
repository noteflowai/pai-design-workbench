import { spawn } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { NativeDiff, NativeStress, RadarDocument, type DiffResult, type RadarResult, type Receipt, type StressResult } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import type { Config } from "./config.js";

export interface AdapterResult<T> { value: T; raw: string; receipt: Receipt }
export interface Adapters {
  radar(): Promise<{ value: RadarResult; raw: string; digest: string }>;
  sourceDigests(): Promise<Record<string, string>>;
  stress(): Promise<AdapterResult<StressResult>>;
  diff(directory: string): Promise<AdapterResult<DiffResult>>;
  controller(): Promise<{ state: string; mode: "read-only-accounting"; publicationApproved: false }>;
}
/**
 * Run a fixed native executable without a shell. `onLine` observes complete stdout lines as they
 * arrive (used for presentation-only live progress); it never changes the retained result.
 */
export async function command(command: string, args: string[], cwd: string, pythonPath?: string, timeout = 45_000,
  onLine?: (line: string) => void, extraEnv: Record<string, string> = {}) {
  const startedAt = new Date().toISOString();
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((accept, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", ...(pythonPath ? { PYTHONPATH: pythonPath } : {}), ...extraEnv } });
    let stdout = "", stderr = "", stopped = false, pending = "";
    const emit = (text: string) => {
      if (!onLine) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (pending.length > 65_536) pending = "";
      for (const line of lines) { try { onLine(line); } catch { /* Observers cannot affect native execution. */ } }
    };
    const terminate = () => {
      if (child.pid) {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    };
    const timer = setTimeout(() => { stopped = true; terminate(); }, timeout);
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout += text; emit(text);
      if (Buffer.byteLength(stdout) > 4_000_000) { stopped = true; terminate(); }
    });
    child.stderr.on("data", chunk => {
      if (Buffer.byteLength(stderr) < 100_000) stderr += chunk.toString();
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (stopped) reject(new DomainError("NATIVE_INTERRUPTED", "Native process exceeded its bounded deadline/output; no automatic replay", 503));
      else accept({ stdout, stderr, exitCode: code ?? 2 });
    });
  });
  return { ...result, startedAt, finishedAt: new Date().toISOString() };
}
export class NativeAdapters implements Adapters {
  constructor(public config: Config) {}
  async radar() {
    const raw = await readFile(this.config.radarFile, "utf8");
    return { value: RadarDocument.parse(JSON.parse(raw)), raw, digest: sha256(raw) };
  }
  async sourceDigests() {
    const files: Record<string, string> = {
      "stress/experiment.json": join(this.config.stressSource, "experiment.json"),
      "stress/summary.json": join(this.config.stressSource, "summary.json"),
      "stress/manifest.json": join(this.config.stressSource, "manifest.json"),
    };
    const collect = async (directory: string, prefix: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), name = `${prefix}/${entry.name}`;
        if (entry.isDirectory() && entry.name !== "__pycache__") await collect(path, name);
        else if (entry.isFile() && entry.name.endsWith(".py")) files[name] = path;
      }
    };
    await Promise.all([collect(join(this.config.robotRoot, "robot_reel"), "robot-reel/robot_reel"),
      collect(join(this.config.evalarcRoot, "src/evalarc"), "evalarc/src/evalarc")]);
    const entries = await Promise.all(Object.entries(files).map(async ([name, path]) => [name, sha256(await readFile(path))]));
    return Object.fromEntries(entries);
  }
  async stress(): Promise<AdapterResult<StressResult>> {
    const before = await this.sourceDigests();
    const args = ["-B", "-m", "robot_reel.cli", "stress", this.config.stressSource, "--paired-exact"];
    const r = await command("python3", args, this.config.robotRoot, this.config.robotRoot);
    if (r.exitCode !== 0) throw new DomainError("ROBOT_VERIFICATION_FAILED", "Robot Reel rejected the source recording", 422);
    if (canonical(before) !== canonical(await this.sourceDigests())) throw new DomainError("SOURCE_CHANGED", "Sources changed during native verification");
    return { value: NativeStress.parse(JSON.parse(r.stdout)), raw: r.stdout,
      receipt: { adapter: "robot-reel-native", command: ["python3", ...args], startedAt: r.startedAt,
        finishedAt: r.finishedAt, exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: before } };
  }
  async diff(directory: string): Promise<AdapterResult<DiffResult>> {
    const args = ["-B", "-m", "evalarc", "diff", join(directory, "baseline.xml"), join(directory, "current.xml"),
      "--format", "junit", "--output", join(directory, "evalarc"), "--json"];
    const r = await command("python3", args, this.config.evalarcRoot, join(this.config.evalarcRoot, "src"));
    if (![0, 1].includes(r.exitCode)) throw new DomainError("EVALARC_PIPELINE_FAILED", "EvalArc could not compare native check results", 422);
    const value = NativeDiff.parse(JSON.parse(r.stdout));
    if (value.gate_passed !== (r.exitCode === 0)) throw new DomainError("EVALARC_INCONSISTENT", "Native exit code and gate disagree", 422);
    return { value, raw: r.stdout, receipt: { adapter: "evalarc-native", command: ["python3", ...args],
      startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode, stdoutSha256: sha256(r.stdout),
      sourceDigests: { "baseline.xml": sha256(await readFile(join(directory, "baseline.xml"))),
        "current.xml": sha256(await readFile(join(directory, "current.xml"))) } } };
  }
  async controller() {
    try {
      const args = ["-B", "-m", "agent_control", "budget-status"];
      if (this.config.controllerDatabase) args.push("--database", this.config.controllerDatabase);
      const r = await command("python3", args, this.config.controlRoot, this.config.controlRoot, 10_000);
      const data: unknown = JSON.parse(r.stdout);
      const state = typeof data === "object" && data !== null && "state" in data && typeof data.state === "string" ? data.state : "unavailable";
      return { state, mode: "read-only-accounting" as const, publicationApproved: false as const };
    } catch {
      return { state: "unavailable", mode: "read-only-accounting" as const, publicationApproved: false as const };
    }
  }
}
export async function writePrivate(path: string, content: string | Buffer) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600, flag: "wx" });
}
