// Test double for the NoteFlow text executor. Validates the request contract PAI writes, writes
// per-attempt receipts like the real executor, and prints a report. Driven by FAKE_EXECUTOR (JSON).
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { state: { type: "string" }, database: { type: "string" }, request: { type: "string" } } });
const request = JSON.parse(readFileSync(values.request, "utf8"));
const fail = (m) => { console.error(m); process.exit(2); };
const keys = ["schema_version", "kind", "run_id", "prompt_file", "profiles", "timeout_seconds", "max_attempts", "cost_bounds_microusd"];
if (Object.keys(request).sort().join() !== [...keys].sort().join()) fail("request keys");
if (request.schema_version !== 1 || request.kind !== "text-proposal" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.run_id)) fail("request identity");
if (!(request.timeout_seconds >= 1 && request.timeout_seconds <= 60) || request.max_attempts > 5 || request.max_attempts < 1) fail("request bounds");
const prompt = readFileSync(request.prompt_file, "utf8");
const spec = JSON.parse(process.env.FAKE_EXECUTOR ?? (process.env.FAKE_EXECUTOR_FILE ? readFileSync(process.env.FAKE_EXECUTOR_FILE, "utf8") : "{}"));
if (spec.log) appendFileSync(spec.log, JSON.stringify({ run_id: request.run_id, profiles: request.profiles, promptBytes: Buffer.byteLength(prompt), prompt }) + "\n");
const dir = join(values.state, "runs", request.run_id);
mkdirSync(dir, { recursive: true });
let final;
for (const a of spec.attempts ?? []) {
  const id = createHash("sha256").update(request.run_id + a.profile).digest("hex");
  const receipt = { attempt_id: id, status: a.status, effects: a.effects ?? "none", answer: a.answer ?? null,
    error: a.errorKind ? { kind: a.errorKind } : null, requested: { profile: a.profile, model: a.model ?? "claude-opus-5.5", effort: "high" },
    observed: { model: a.model ?? "claude-opus-5.5", engine_version: a.version ?? "2.24.0", model_evidence: "acp_advertised" } };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(receipt));
  final = receipt;
}
const action = spec.action ?? "done";
console.log(JSON.stringify({ flow_run_id: "fake", flow_status: spec.flowStatus ?? "completed", report: {
  schema_version: 1, run_id: request.run_id, action, reason: spec.reason ?? "fixture", publication_approved: false,
  ...(final && ["done", "reconcile"].includes(action) ? { result: final } : {}) } }));
process.exitCode = action === "done" ? 0 : 1;
