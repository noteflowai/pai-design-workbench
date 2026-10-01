import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { command } from "../src/adapters.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import { sandboxArgs, sandboxRuntime, sandboxStatus } from "../src/sandbox.js";
import type { Feedback, Project } from "../src/contracts.js";

/**
 * Generated CadQuery code lane: each isolation layer on its own, then the full loop through the API —
 * template equivalence with the preset recipe, failure → feedback → recheck with fixed code → closed,
 * and policy, runtime-error and resource-limit outcomes that never produce evidence.
 */
const config = configuration();
assert.ok(config.cadquery, "Run npm run setup:cad or set PAI_CADQUERY_PYTHON");
const status = await sandboxStatus(config);
assert.ok(status.available, `bubblewrap sandbox unavailable: ${status.reason}`);
const state = join(config.state, "cad-code-e2e", randomUUID());
await mkdir(state, { recursive: true, mode: 0o700 });
const template = await readFile(join(config.repository, "native/cad_template.py"), "utf8");
const withThickness = (t: number) => template.replace("T = 4.0 ", `T = ${t} `);
assert.notEqual(withThickness(2.5), template);

// Layers 2–3 in isolation: a trusted probe inside bubblewrap, without and with the process lockdown.
const runtime = await sandboxRuntime(config);
const secret = join(config.state, "probe-secret.txt");
await writeFile(secret, "not-a-real-secret\n", { mode: 0o600 });
const probe = async (mode: "os" | "process") => {
  const out = join(state, `probe-${mode}`); await mkdir(out, { recursive: true });
  const fixture = join(config.repository, "tests/fixtures/sandbox_probe.py");
  const r = await command(config.bwrap ?? "bwrap", sandboxArgs(config, runtime, { readOnly: [fixture], writable: [out] },
    [runtime.python, "-I", fixture, mode, out, secret, runtime.native]), config.repository, undefined, 60_000);
  assert.equal(r.exitCode, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
};
const osLayer = await probe("os"), processLayer = await probe("process");
assert.equal(osLayer["read-secret"], "FileNotFoundError", "workbench state is hidden");
assert.equal(osLayer["write-outside"], "OSError", "native scripts are read-only");
assert.equal(osLayer["write-output"], "allowed");
assert.notEqual(osLayer.network, "allowed", "no network namespace route");
assert.deepEqual(osLayer.env, []); assert.equal(osLayer["home-visible"], false); assert.equal(osLayer["run-entries"], 0);
for (const k of ["write-outside", "network", "subprocess", "os-system", "ctypes"]) assert.equal(processLayer[k], "PermissionError", `audit hook blocks ${k}`);
assert.equal(processLayer["write-output"], "allowed");

const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const call = async (method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers });
  return { status: r.statusCode, body: r.json() };
};
const ok = async <T>(method: "POST" | "PATCH", url: string, payload: unknown) => { const r = await call(method, url, payload); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as T; };
try {
  const caps = (await call("GET", "/api/state")).body.capabilities.cad;
  assert.equal(caps.generatedCode.available, true); assert.equal(caps.generatedCode.template, template);
  const project = await ok<Project>("POST", "/api/projects", { title: "AI-written NEMA 17 bracket", intendedDecision: "Accept generated geometry only through the same native checks",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const cad = (code: string, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), projectRevision: 1, variant: "generated",
    requirements: DEFAULT_CAD_REQUIREMENTS, source: { language: "cadquery-2.8", code }, ...extra });
  const url = `/api/projects/${project.id}/cad`;

  // Template through the sandbox equals the preset reference recipe, check by check.
  const t0 = Date.now();
  const ref = await ok<CadReview>("POST", url, cad(template));
  const seconds = Math.round((Date.now() - t0) / 1000);
  assert.equal(ref.state, "completed", ref.error ?? ""); assert.equal(ref.verdict, "accepted-cad-part");
  assert.equal(ref.sandbox?.status, "ok"); assert.equal(ref.sandbox?.motorAxisZ, 28);
  assert.deepEqual(ref.candidate!.checks.map(c => [c.id, c.passed, c.observed]), ref.baseline!.checks.map(c => [c.id, c.passed, c.observed]));
  assert.equal(ref.candidate!.mass, ref.baseline!.mass);
  assert.deepEqual(ref.receipts.map(r => r.adapter).slice(0, 3), ["cadquery-native", "cadquery-sandbox", "cadquery-sandbox-check"]);
  assert.ok(ref.files["candidate/generated.brep"] && ref.files["candidate/part.step"]);
  assert.deepEqual(ref.stages?.candidate?.map(s => s.id), ["generated", "motor"]);

  // Thin plates fail natively; feedback; recheck with corrected code closes it.
  const thin = await ok<CadReview>("POST", url, cad(withThickness(2.5)));
  assert.equal(thin.verdict, "rejected");
  assert.deepEqual(thin.candidate!.checks.filter(c => !c.passed).map(c => c.id), ["min-wall"]);
  assert.equal(thin.candidate!.checks.find(c => c.id === "min-wall")!.observed, 2.5);
  let f = await ok<Feedback>("POST", "/api/feedback", { runId: thin.id, evidenceKind: "cad-part", kind: "design-check", checkId: "min-wall", seed: null,
    expected: "Plates at least 3 mm", observed: "Generated code uses 2.5 mm plates", actorKind: "maintainer" });
  for (const s of ["reproducible", "assigned", "fix-proposed"]) f = await ok<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: s, reason: "Regenerate with T = 3.5 mm" });
  const fixed = await ok<CadReview>("POST", url, cad(withThickness(3.5), { feedbackId: f.id }));
  assert.equal(fixed.verdict, "accepted-cad-part", JSON.stringify(fixed.candidate?.checks.filter(c => !c.passed)));
  f = await ok<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason: "Regenerated code passes min-wall", recheckRunId: fixed.id });
  f = await ok<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "3.5 mm plates; nominal geometry only" });

  // Outcomes that never become evidence.
  const before = (await call("GET", "/api/state")).body.cads.length;
  const policy = await call("POST", url, cad(template.replace("import cadquery as cq", "import cadquery as cq\nimport os")));
  assert.equal(policy.status, 422); assert.equal(policy.body.error, "CAD_CODE_POLICY");
  const dunder = await call("POST", url, cad(template + "\nleak = cq.Workplane.__init__.__globals__\n"));
  assert.equal(dunder.status, 422);
  assert.equal((await call("GET", "/api/state")).body.cads.length, before, "policy violations create no record");
  const check = await call("POST", "/api/cad/code-check", { code: "import subprocess\nresult = 1\nMOTOR_AXIS_Z = 28\n" });
  assert.equal(check.body.ok, false);
  const outcomes: Record<string, string> = {};
  for (const [name, code] of [
    ["submodule", template + "\nhidden = cq.utils\n"],
    ["two-solids", template.replace("result = body", "result = body.union(cq.Workplane('XY').box(5, 5, 5).translate((200, 0, 0)))")],
    ["memory", template + "\nblob = [0] * (10 ** 10)\n"],
  ] as const) {
    const r = await ok<CadReview>("POST", url, cad(code));
    assert.equal(r.state, "failed"); assert.equal(r.candidate, undefined);
    outcomes[name] = `${r.sandbox?.status}: ${r.error?.split(":")[0]}`;
  }
  assert.deepEqual(outcomes, { submodule: "error: CAD_CODE_ERROR", "two-solids": "error: CAD_CODE_ERROR", memory: "limit: CAD_CODE_LIMIT" });
  // CPU limit, exercised directly with a short budget.
  const loopOut = join(state, "loop"); await mkdir(loopOut, { recursive: true });
  const loopCode = join(state, "loop.py"); await writeFile(loopCode, template + "\nwhile True:\n    T = T + 1\n");
  const loop = await command(config.bwrap ?? "bwrap", sandboxArgs(config, runtime, { readOnly: [loopCode], writable: [loopOut] },
    [runtime.python, "-I", join(runtime.native, "cad_sandbox.py"), "--code", loopCode, "--output", loopOut, "--cpu-seconds", "3"]), config.repository, undefined, 60_000);
  assert.notEqual(loop.exitCode, 0); await assert.rejects(readFile(join(loopOut, "result.json")), "killed by RLIMIT_CPU before reporting");

  const report = { schema: "pai-cad-code-e2e-1", checkedAt: new Date().toISOString(), result: "passed", bubblewrap: status.bwrap,
    isolation: ref.sandbox!.isolation, layers: { os: osLayer, process: processLayer },
    templateEqualsPresetReference: true, templateSeconds: seconds, thin: { failed: ["min-wall"], observedMm: 2.5 }, recheck: { feedback: f.status, verdict: fixed.verdict },
    neverEvidence: { policy: "422 CAD_CODE_POLICY (no record)", dunderEscape: "422", ...outcomes, cpuLoop: "killed by RLIMIT_CPU (3 s budget in test, 60 s in service)" },
    physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence/cad-code-e2e.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
