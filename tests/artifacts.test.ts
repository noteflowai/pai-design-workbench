import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";
import { Store } from "../src/store.js";
import { createArtifact, decideArtifact, exportArtifact, verifyArtifactPackage, type ArtifactVersion } from "../src/artifacts/registry.js";
import { validateWorkflow } from "../src/artifacts/workflows.js";
import { planning } from "./fixtures/workflows.js";

const REF = "logistics-pdptw@1.0.0";
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

async function registry() {
  const dir = await mkdtemp(join(tmpdir(), "pai-artifacts-"));
  const config = { ...configuration(), state: dir };
  const store = new Store(join(dir, "w.sqlite"));
  const a = await createArtifact(store, config, { adapter: "logistics-pdptw", version: "1.0.0" }, "tester");
  return { dir, config, store, a, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}
/** Unit tests run without OR-Tools: stand in for the acceptance benchmark (scripts/artifact-e2e.ts runs the real one). */
function markValidated(store: Store, a: ArtifactVersion) {
  const next = { ...a, revision: a.revision + 1, state: "validated" as const, validation: { at: "t", passed: true, evidence: { unit: true }, runId: randomUUID(), usage: {} as never } };
  store.put("artifact", next, a.revision);
  return next;
}

test("artifact versions are immutable, start as draft and are pinned by digest", async () => {
  const r = await registry();
  try {
    assert.equal(r.a.state, "draft");
    assert.equal(r.a.manifest.kind, "algorithm");
    assert.equal(r.a.manifest.dependencies.find(d => d.name === "ortools")?.license, "Apache-2.0");
    assert.ok(r.a.manifest.dependencies.every(d => d.license !== "unknown"), "every locked dependency has a recorded licence");
    const again = await createArtifact(r.store, r.config, { adapter: "logistics-pdptw", version: "1.0.0" }, "other");
    assert.equal(again.digest, r.a.digest, "rebuilding identical sources is the same version");
    const tampered = { ...r.a, manifest: { ...r.a.manifest, limits: { ...r.a.manifest.limits, maxOrders: 9 } } };
    r.store.put("artifact", { ...tampered, revision: r.a.revision + 1 }, r.a.revision);
    await assert.rejects(createArtifact(r.store, r.config, { adapter: "logistics-pdptw", version: "1.0.0" }, "x"), /ARTIFACT_IMMUTABLE|different content/);
    await assert.rejects(createArtifact(r.store, r.config, { adapter: "no-such", version: "1.0.0" }, "x"), /No artifact adapter/);
    assert.throws(() => decideArtifact(r.store, REF, { to: "released", reason: "ship it now" }, "x"), /INVALID_TRANSITION|no passing validation/);
  } finally { await r.cleanup(); }
});

test("workflow definitions are rejected before running: schema, references, types, cycles and unusable versions", async () => {
  const r = await registry();
  try {
    assert.throws(() => validateWorkflow(r.store, planning()), /draft; only validated or released/, "draft artifacts cannot be pinned");
    markValidated(r.store, r.a);
    assert.deepEqual(validateWorkflow(r.store, planning()).order, ["solve", "verify", "gate", "dispatcher"]);
    const bad = (nodes: unknown[], extra: Record<string, unknown> = {}) => () => validateWorkflow(r.store, planning({ nodes, ...extra }));
    const [solve, verify, gate] = planning().nodes as Record<string, unknown>[];
    assert.throws(() => validateWorkflow(r.store, { ...planning(), extra: 1 }), /WORKFLOW_SCHEMA|Unrecognized/);
    assert.throws(bad([{ ...solve, artifact: "logistics-pdptw@latest" }]), /exact artifact version/);
    assert.throws(bad([{ ...solve, artifact: "logistics-pdptw@9.9.9" }, verify]), /not found/);
    assert.throws(bad([{ ...solve, operation: "teleport" }]), /no operation teleport/);
    assert.throws(bad([solve, { ...verify, inputs: { problem: "$input.problem", plan: "$input.problem" } }]), /needs pai-logistics-plan-1 but \$input.problem is pai-logistics-problem-1/);
    assert.throws(bad([solve, { ...verify, inputs: { problem: "$input.problem" } }]), /input plan .* is not wired/);
    assert.throws(bad([{ ...solve, params: { timeLimitSeconds: 9999 } }, verify]), /params/);
    assert.throws(bad([{ ...solve, after: ["gate"] }, verify, gate]), /cycle among/);
    assert.throws(bad([solve, solve]), /duplicate/);
    assert.throws(bad([solve], { outputs: { x: "$nope.plan" } }), /unresolved/);
    const deprecated = decideArtifact(r.store, REF, { to: "deprecated", reason: "superseded by 1.1.0" }, "maintainer");
    assert.equal(deprecated.state, "deprecated");
    assert.throws(() => validateWorkflow(r.store, planning()), /deprecated/, "deprecated versions cannot be newly used");
  } finally { await r.cleanup(); }
});

test("artifact packages are signed; any modified file, manifest or signature is rejected offline", async () => {
  const r = await registry();
  try {
    await assert.rejects(exportArtifact(r.store, r.config, REF), /validated before it is packaged/);
    markValidated(r.store, r.a);
    const pkg = await exportArtifact(r.store, r.config, REF);
    assert.equal(verifyArtifactPackage(pkg).valid, true);
    const clone = () => JSON.parse(JSON.stringify(pkg));
    const file = clone(); file.files["logistics_solve.py"].contentBase64 = Buffer.from("print('x')").toString("base64");
    assert.throws(() => verifyArtifactPackage(file), code("PACKAGE_FILE"));
    const manifest = clone(); manifest.manifest.limits.maxOrders = 5000;
    assert.throws(() => verifyArtifactPackage(manifest), code("PACKAGE_MANIFEST"));
    const evidence = clone(); evidence.validation.evidence = { forged: true };
    assert.throws(() => verifyArtifactPackage(evidence), code("PACKAGE_MANIFEST"));
    const sig = clone(); sig.signature.value = Buffer.from("not a signature").toString("base64");
    assert.throws(() => verifyArtifactPackage(sig), code("PACKAGE_SIGNATURE"));
    assert.throws(() => verifyArtifactPackage({ ...clone(), schema: "pai-release-package-1" }), code("PACKAGE_SCHEMA"));
  } finally { await r.cleanup(); }
});

test("artifact APIs: anonymous hosted requests are refused, nothing is reachable through the agent API, cross-origin writes fail", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-artifact-auth-"));
  const albAuth = { albArn: "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/example/0000000000000000",
    issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", clientId: "test-client" };
  const hosted = await createApp({ ...configuration(), state, publicOrigin: "https://pai.oneai.host", albAuth }, {} as Adapters);
  try {
    const host = { host: "pai.oneai.host" };
    for (const [method, url] of [["GET", "/api/v1/artifacts"], ["POST", "/api/v1/artifacts"], ["GET", `/api/v1/artifacts/${REF}/package`],
      ["POST", "/api/v1/artifact-packages"], ["POST", "/api/v1/workflows"], ["POST", "/api/v1/workflow-runs"]] as const) {
      const res = await hosted.app.inject({ method, url, headers: { ...host, "x-amzn-oidc-identity": "forged", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        payload: method === "POST" ? "{}" : undefined });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
    for (const url of ["/api/agent/v1/artifacts", "/api/agent/artifacts", "/api/agent/v1/workflow-runs"]) {
      assert.equal((await hosted.app.inject({ url, headers: { ...host, authorization: "Bearer x" } })).statusCode, 404, url);
    }
  } finally { await hosted.app.close(); }
  const local = await createApp({ ...configuration(), state: join(state, "local"), controllerEntrypoint: undefined, controllerDatabase: undefined, albAuth: undefined }, {} as Adapters);
  try {
    const host = `127.0.0.1:${configuration().port}`;
    const res = await local.app.inject({ method: "POST", url: "/api/v1/artifacts", headers: { host, origin: "https://attacker.example", "content-type": "application/json" },
      payload: JSON.stringify({ adapter: "logistics-pdptw", version: "1.0.0" }) });
    assert.equal(res.statusCode, 403);
    const ok = await local.app.inject({ method: "POST", url: "/api/v1/artifacts", headers: { host, "content-type": "application/json" },
      payload: JSON.stringify({ adapter: "logistics-pdptw", version: "1.0.0" }) });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().state, "draft");
    const invalid = await local.app.inject({ method: "POST", url: "/api/v1/workflow-validation", headers: { host, "content-type": "application/json" },
      payload: JSON.stringify(planning({ nodes: [] })) });
    assert.equal(invalid.json().valid, false);
    assert.equal(invalid.json().error, "WORKFLOW_SCHEMA");
  } finally { await local.app.close(); await rm(state, { recursive: true, force: true }); }
});
