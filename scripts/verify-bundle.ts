import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { command } from "../src/adapters.js";
import { verifyBundle } from "../src/bundle.js";
import { configuration } from "../src/config.js";
import { NativeDiff } from "../src/contracts.js";
import { canonical, DomainError } from "../src/domain.js";

export async function verifyWithNative(input: unknown, evalarcRoot: string) {
  const result = verifyBundle(input);
  const dir = await mkdtemp(join(tmpdir(), "pai-handoff-"));
  try {
    await Promise.all(["baseline.xml", "current.xml"].map(name => writeFile(join(dir, name), result.bundle.files[name].content)));
    const r = await command("python3", ["-B", "-m", "evalarc", "diff", join(dir, "baseline.xml"), join(dir, "current.xml"),
      "--format", "junit", "--output", join(dir, "result"), "--json"], evalarcRoot, join(evalarcRoot, "src"));
    const value = NativeDiff.parse(JSON.parse(r.stdout)), saved = NativeDiff.parse(JSON.parse(result.bundle.files["evalarc.json"].content));
    // Native reports may embed filenames. Stable case/check/kind and gate must match.
    const changes = (v: typeof value) => v.changes.map(c => ({ case_id: c.case_id, check: c.check, kind: c.kind }));
    if (value.gate_passed !== saved.gate_passed || value.blocking_changes !== saved.blocking_changes
        || canonical(changes(value)) !== canonical(changes(saved)) || r.exitCode !== (value.gate_passed ? 0 : 1)) {
      throw new DomainError("NATIVE_HANDOFF_MISMATCH", "Fresh EvalArc output differs from the saved review");
    }
    const { bundle: _, ...report } = result;
    return { ...report, nativeEvalArcReexecuted: true, nativeExitCode: r.exitCode };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: npm run verify:bundle -- PATH.json");
  console.log(JSON.stringify(await verifyWithNative(JSON.parse(await readFile(process.argv[2], "utf8")), configuration().evalarcRoot), null, 2));
}
