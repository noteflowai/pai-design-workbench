/**
 * Artifact platform, end to end with the real OR-Tools runtime (no fakes):
 *   create artifact → acceptance benchmark (validated) → release by a person → configure workflow → run
 *   (solve → independent verify → condition → human approval) → signed package → offline verification →
 *   clean environment: import, validate there, run the same workflow, identical plan.
 * Negatives: workflow schema error, infeasible order, solver timeout, tampered package, foreign code in a re-signed
 * package, unauthorised access (tests/artifacts.test.ts covers the hosted 401/404 paths; repeated here for the record).
 * Evidence: .state/evidence/artifact-e2e.json (synthetic instances only; no customer data).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { sha256 } from "../src/domain.js";
import { packageManifest, type ArtifactPackage, type ArtifactVersion } from "../src/artifacts/registry.js";
import type { Workflow, WorkflowRun } from "../src/artifacts/workflows.js";
import { signManifest } from "../src/signing.js";
import { planning } from "../tests/fixtures/workflows.js";

const base = configuration();
assert.ok(base.logisticsPython, "Run python3 tools/setup_logistics.py (sets PAI_LOGISTICS_PYTHON in .state/demo.env)");
// `--clean <dir>`: the clean side, run as a separate process (own signer, own store, optionally own OR-Tools venv).
const cleanArg = process.argv.indexOf("--clean");
const root = cleanArg > 0 ? process.argv[cleanArg + 1] : join(base.state, "artifact-e2e", randomUUID());
const REF = "logistics-pdptw@1.0.0";
const evidence: Record<string, unknown> = { schema: "pai-artifact-e2e-1", startedAt: new Date().toISOString(), synthetic: true };
let originKey = "";

async function environment(name: string, logisticsPython = base.logisticsPython) {
  const state = join(root, name);
  const config = { ...base, state, logisticsPython, controllerEntrypoint: undefined, controllerDatabase: undefined };
  const { app } = await createApp(config, {} as never);
  const host = `127.0.0.1:${config.port}`;
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { host, ...(payload === undefined ? {} : { "content-type": "application/json" }) } });
    return { status: r.statusCode, body: r.json() };
  };
  const ok = async <T>(method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await call(method, url, payload); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as T;
  };
  return { app, config, call, ok };
}
const instance = async (scenario: string, seed: number, orders: number, vehicles: number) => {
  const f = join(root, `${scenario}-${seed}-${orders}.json`);
  execFileSync("python3", ["-I", "native/logistics_generate.py", "--seed", String(seed), "--orders", String(orders), "--vehicles", String(vehicles), "--scenario", scenario, "--output", f]);
  return JSON.parse(await readFile(f, "utf8"));
};
const summary = (run: WorkflowRun) => ({ id: run.id, state: run.state, error: run.error ?? null,
  nodes: Object.fromEntries(Object.entries(run.nodes).map(([k, n]) => [k, { state: n.state, status: n.status ?? null, usage: n.usage?.native ?? null, model: n.usage?.model.status ?? null }])) });

if (cleanArg > 0) { await clean(); process.exit(0); }
await mkdir(root, { recursive: true, mode: 0o700 });
const A = await environment("origin");
try {
  // 1. Artifact: build from this release's sources (draft), validate by its own benchmark, release by a person.
  const draft = await A.ok<ArtifactVersion>("POST", "/api/v1/artifacts", { adapter: "logistics-pdptw", version: "1.0.0" });
  assert.equal(draft.state, "draft");
  const early = await A.call("POST", "/api/v1/workflows", planning());
  assert.equal(early.status, 422, "a workflow cannot pin a draft"); assert.match(early.body.message, /draft/);
  const validated = await A.ok<ArtifactVersion>("POST", `/api/v1/artifacts/${REF}/validation`);
  assert.equal(validated.state, "validated", JSON.stringify(validated.validation?.evidence));
  const released = await A.ok<ArtifactVersion>("POST", `/api/v1/artifacts/${REF}/lifecycle`, { to: "released", reason: "Benchmark verified; scope synthetic instances" });
  assert.equal(released.state, "released");
  evidence.artifact = { id: REF, digest: released.digest, files: released.files, dependencies: released.manifest.dependencies.filter(d => d.role === "solver"),
    sourceCommit: released.manifest.provenance.sourceCommit, benchmark: released.validation?.evidence, lifecycle: released.history.map(h => `${h.from ?? "-"}→${h.to}`) };

  // 2. Workflow configuration, with a schema error rejected first.
  const schemaError = await A.call("POST", "/api/v1/workflows", { ...planning(), nodes: [{ id: "solve", type: "artifact", artifact: REF, operation: "solve", inputs: { problem: "$input.problem" }, retries: 3 }] });
  assert.equal(schemaError.status, 422); assert.equal(schemaError.body.error, "WORKFLOW_SCHEMA");
  const workflow = await A.ok<Workflow>("POST", "/api/v1/workflows", planning());
  const changed = await A.call("POST", "/api/v1/workflows", planning({ title: "changed" }));
  assert.equal(changed.status, 409, "a saved workflow version is immutable");

  // 3. Run: solve → verify → condition → approval.
  const problem = await instance("normal", 11, 40, 8);
  const requestId = randomUUID();
  const waiting = await A.ok<WorkflowRun>("POST", "/api/v1/workflow-runs", { requestId, workflow: workflow.id, inputs: { problem } });
  assert.equal(waiting.state, "waiting-approval", JSON.stringify(summary(waiting)));
  assert.equal(waiting.nodes.verify.status, "feasible-plan");
  const same = await A.ok<WorkflowRun>("POST", "/api/v1/workflow-runs", { requestId, workflow: workflow.id, inputs: { problem } });
  assert.equal(same.id, waiting.id, "one request identity, one run");
  const reused = await A.call("POST", "/api/v1/workflow-runs", { requestId, workflow: workflow.id, inputs: { problem: { ...problem, horizonMin: 10 } } });
  assert.equal(reused.status, 409, "request identity cannot be reused for other inputs");
  const done = await A.ok<WorkflowRun>("POST", `/api/v1/workflow-runs/${waiting.id}/decisions`, { node: "dispatcher", approve: true, reason: "调度员核对后确认（合成实例）" });
  assert.equal(done.state, "succeeded");
  const plan = await A.ok<{ routes: unknown[]; totalDistanceKm: number; status: string }>("GET", `/api/v1/workflow-runs/${done.id}/data?name=plan`);
  const verification = await A.ok<{ verdict: string; checks: { id: string; passed: boolean }[] }>("GET", `/api/v1/workflow-runs/${done.id}/data?name=verification`);
  assert.equal(verification.verdict, "feasible-plan"); assert.ok(verification.checks.every(c => c.passed));
  const planDigest = sha256(JSON.stringify(plan.routes));
  evidence.run = { ...summary(done), instance: { seed: 11, orders: 40, vehicles: 8 }, plan: { status: plan.status, distanceKm: plan.totalDistanceKm, routes: plan.routes.length, routesSha256: planDigest },
    checks: verification.checks.map(c => `${c.id}:${c.passed}`) };

  // 4. Negatives in the business process: infeasible order, solver timeout.
  const overload = await A.ok<WorkflowRun>("POST", "/api/v1/workflow-runs", { requestId: randomUUID(), workflow: workflow.id, inputs: { problem: await instance("overload", 11, 40, 8) } });
  assert.equal(overload.state, "rejected"); assert.equal(overload.nodes.solve.status, "infeasible"); assert.equal(overload.nodes.verify.status, "no-plan");
  assert.equal(overload.nodes.dispatcher.state, "pending", "no approval is requested for a rejected plan");
  const quick = await A.ok<Workflow>("POST", "/api/v1/workflows", planning({ name: "offsite-delivery-quick", nodes: planning().nodes.map(n => n.id === "solve" ? { ...n, params: { timeLimitSeconds: 0.05 } } : n) }));
  const timeout = await A.ok<WorkflowRun>("POST", "/api/v1/workflow-runs", { requestId: randomUUID(), workflow: quick.id, inputs: { problem: await instance("normal", 5, 200, 30) } });
  assert.equal(timeout.state, "rejected"); assert.equal(timeout.nodes.solve.status, "timeout");
  const badInput = await A.call("POST", "/api/v1/workflow-runs", { requestId: randomUUID(), workflow: workflow.id, inputs: { problem: { ...problem, orders: [] } } });
  assert.equal(badInput.status, 422); assert.equal(badInput.body.error, "INVALID_INPUT");
  evidence.negatives = { workflowSchemaError: schemaError.body.error, infeasible: summary(overload), timeout: summary(timeout), invalidInput: badInput.body.error };

  // 5. Signed package; offline verification; tampering.
  const pkg = await A.ok<ArtifactPackage>("GET", `/api/v1/artifacts/${REF}/package`);
  const key = await A.ok<{ publicKeyPem: string }>("GET", "/api/signing/public-key");
  originKey = key.publicKeyPem;
  const verified = await A.ok<{ valid: boolean; signer: { trusted: boolean } }>("POST", "/api/v1/artifact-packages/verification", { package: pkg, trustedPublicKeyPem: key.publicKeyPem });
  assert.equal(verified.valid, true); assert.equal(verified.signer.trusted, true);
  const tampered = JSON.parse(JSON.stringify(pkg)) as ArtifactPackage;
  tampered.files["logistics_verify.py"].contentBase64 = Buffer.from(Buffer.from(tampered.files["logistics_verify.py"].contentBase64, "base64").toString().replace("passed", "True or")).toString("base64");
  const tamperResult = await A.ok<{ valid: boolean; error: string }>("POST", "/api/v1/artifact-packages/verification", { package: tampered });
  assert.equal(tamperResult.valid, false); assert.equal(tamperResult.error, "PACKAGE_FILE");
  const pkgFile = join(root, "logistics-pdptw-1.0.0.package.json");
  await writeFile(pkgFile, JSON.stringify(pkg), { mode: 0o600 });
  evidence.package = { file: "logistics-pdptw-1.0.0.package.json", sha256: sha256(JSON.stringify(pkg)), manifestSha256: pkg.manifestSha256, signer: { algorithm: pkg.signature.algorithm, keyId: pkg.signature.keyId },
    tampered: tamperResult.error };
} finally { await A.app.close(); }

// 6. Clean environment in a separate process: fresh state directory, store and signing key; only the package file,
// the origin's public key (pinned out of band) and the expected digests cross.
// PAI_ARTIFACT_CLEAN_VENV=<empty dir>: the clean side also installs its own OR-Tools from the hash lock (no shared venv).
let cleanPython = base.logisticsPython!, cleanVenv: string | null = null;
if (process.env.PAI_ARTIFACT_CLEAN_VENV) {
  cleanVenv = process.env.PAI_ARTIFACT_CLEAN_VENV;
  execFileSync("python3.12", ["tools/setup_logistics.py"], { env: { ...process.env, PAI_TOOLS_DIR: cleanVenv, PAI_ENV_FILE: join(root, "clean.env") }, stdio: "ignore" });
  cleanPython = join(cleanVenv, "logistics-1", "bin", "python");
}
await writeFile(join(root, "handoff.json"), JSON.stringify({ originKey, routesSha256: (evidence.run as { plan: { routesSha256: string } }).plan.routesSha256,
  digest: (evidence.artifact as { digest: string }).digest }), { mode: 0o600 });
execFileSync(process.execPath, ["--import", "tsx", "scripts/artifact-e2e.ts", "--clean", root],
  { env: { ...process.env, PAI_LOGISTICS_PYTHON: cleanPython, PAI_STATE: join(root, "clean-process") }, stdio: ["ignore", "ignore", "inherit"] });
const reproduction = JSON.parse(await readFile(join(root, "reproduction.json"), "utf8"));
const originSigner = (evidence.package as { signer: { keyId: string } }).signer.keyId;
assert.notEqual(reproduction.signerKeyId, originSigner, "the clean side signs with its own key");
evidence.reproduction = { ...reproduction, environment: `separate process; fresh state directory, store and signing key${cleanVenv ? "; own OR-Tools venv installed from the hash lock" : "; shared OR-Tools venv"}; only the package file and the pinned origin key crossed` };

async function clean() {
const handoff = JSON.parse(await readFile(join(root, "handoff.json"), "utf8")) as { originKey: string; routesSha256: string; digest: string };
const originKey = handoff.originKey;
const B = await environment("clean");
try {
  const pkg = JSON.parse(await readFile(join(root, "logistics-pdptw-1.0.0.package.json"), "utf8")) as ArtifactPackage;
  // Foreign code, correctly re-signed by this environment's own key: verifies, but is not imported.
  const foreign = JSON.parse(JSON.stringify(pkg)) as ArtifactPackage;
  const evil = Buffer.from("import os\nos.system('id')\n");
  foreign.files["logistics_solve.py"] = { sha256: sha256(evil), bytes: evil.length, contentBase64: evil.toString("base64") };
  foreign.manifest.files["logistics_solve.py"] = sha256(evil);
  const { manifestSha256: _m, signature: _s, ...body } = foreign;
  Object.assign(foreign, await signManifest(B.config, packageManifest(body)));
  const foreignImport = await B.call("POST", "/api/v1/artifact-packages", { package: foreign });
  assert.equal(foreignImport.status, 422); assert.equal(foreignImport.body.error, "UNTRUSTED_CODE");
  // Same code, but a manifest claim widened (limits) and re-signed: refused as well.
  const claims = JSON.parse(JSON.stringify(pkg)) as ArtifactPackage;
  claims.manifest.limits.maxOrders = 100_000;
  const { manifestSha256: _m2, signature: _s2, ...claimsBody } = claims;
  Object.assign(claims, await signManifest(B.config, packageManifest(claimsBody)));
  const claimsImport = await B.call("POST", "/api/v1/artifact-packages", { package: claims });
  assert.equal(claimsImport.status, 422); assert.equal(claimsImport.body.error, "UNTRUSTED_CLAIMS");
  // The genuine package from another deployment needs its signer pinned explicitly.
  const unpinned = await B.call("POST", "/api/v1/artifact-packages", { package: pkg });
  assert.equal(unpinned.status, 422); assert.equal(unpinned.body.error, "UNTRUSTED_SIGNER");
  const imported = await B.ok<{ artifact: ArtifactVersion; verified: { valid: boolean } }>("POST", "/api/v1/artifact-packages", { package: pkg, trustedPublicKeyPem: originKey });
  assert.equal(imported.artifact.state, "draft"); assert.equal(imported.artifact.origin, "imported");
  const v = await B.ok<ArtifactVersion>("POST", `/api/v1/artifacts/${REF}/validation`);
  assert.equal(v.state, "validated");
  await B.ok("POST", `/api/v1/artifacts/${REF}/lifecycle`, { to: "released", reason: "Re-validated in a clean environment" });
  const workflow = await B.ok<Workflow>("POST", "/api/v1/workflows", planning());
  const run = await B.ok<WorkflowRun>("POST", "/api/v1/workflow-runs", { requestId: randomUUID(), workflow: workflow.id, inputs: { problem: await instance("normal", 11, 40, 8) } });
  const done = await B.ok<WorkflowRun>("POST", `/api/v1/workflow-runs/${run.id}/decisions`, { node: "dispatcher", approve: true, reason: "复现核对（合成实例）" });
  assert.equal(done.state, "succeeded");
  const plan = await B.ok<{ routes: unknown[] }>("GET", `/api/v1/workflow-runs/${done.id}/data?name=plan`);
  assert.equal(sha256(JSON.stringify(plan.routes)), handoff.routesSha256, "the clean environment reproduces the same plan");
  assert.equal(v.digest, handoff.digest, "same artifact digest");
  const own = await B.ok<{ keyId: string }>("GET", "/api/signing/public-key");
  await writeFile(join(root, "reproduction.json"), JSON.stringify({ foreignCode: foreignImport.body.error, widenedClaims: claimsImport.body.error, unpinnedSigner: unpinned.body.error,
    signerKeyId: own.keyId, ortools: (v.validation?.evidence as { comparison?: { ortools?: { solver?: { version?: string } } } })?.comparison?.ortools?.solver?.version ?? null,
    importedDigest: v.digest, routesSha256: sha256(JSON.stringify(plan.routes)), identical: true, run: summary(done) }), { mode: 0o600 });
} finally { await B.app.close(); }
}

evidence.finishedAt = new Date().toISOString();
evidence.scope = "Synthetic, labelled instances; native compute measured per node, model tokens not involved (status none). No dispatch, no billing.";
await mkdir(join(base.state, "evidence"), { recursive: true, mode: 0o700 });
await writeFile(join(base.state, "evidence", "artifact-e2e.json"), JSON.stringify(evidence, null, 1) + "\n", { mode: 0o600 });
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, artifact: evidence.artifact && (evidence.artifact as { digest: string }).digest, run: (evidence.run as { plan: unknown }).plan,
  negatives: { schema: "WORKFLOW_SCHEMA", infeasible: "rejected", timeout: "rejected", tamper: "PACKAGE_FILE", foreign: "UNTRUSTED_CODE", claims: "UNTRUSTED_CLAIMS", signer: "UNTRUSTED_SIGNER" }, reproduction: "identical" }));
