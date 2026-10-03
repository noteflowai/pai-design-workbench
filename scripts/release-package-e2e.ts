/**
 * Release → signed package → offline verification: an accepted native CAD review is released, packaged with every
 * digest-bound native file, and verified with the pinned public key; tampering with any file is detected.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, DEFAULT_STRUCTURAL, type CadReview } from "../src/cad.js";
import { verifyPackage, verifySealedPackage, type ReleasePackage } from "../src/signing.js";
import type { Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.cadquery && config.physicsPython && config.ccx, "Run npm run setup:cad and npm run setup:physics");
const state = join(config.state, "package-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const req = async <T>(method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
try {
  const project = await req<Project>("POST", "/api/projects", { title: "Release a bracket", intendedDecision: "Adopt the reference bracket within its evidence scope",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const cad = await req<CadReview>("POST", `/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "reference", requirements: { ...DEFAULT_CAD_REQUIREMENTS, structural: DEFAULT_STRUCTURAL } });
  assert.equal(cad.verdict, "accepted-cad-part");
  const rel = await req<{ id: string; revision: number; number: string }>("POST", `/api/projects/${project.id}/releases`,
    { requestId: randomUUID(), projectRevision: 1, evidenceKind: "cad-part", runId: cad.id, title: "Reference bracket" });
  const before = await app.inject({ url: `/api/releases/${rel.id}/package`, headers: { host } });
  assert.equal(before.statusCode, 409, "an unapproved release cannot be packaged");
  await req("PATCH", `/api/projects/${project.id}/releases/${rel.id}`, { expectedRevision: rel.revision, decision: "approve", reason: "All admission checks pass" });
  const pkg = await req<ReleasePackage>("GET", `/api/releases/${rel.id}/package`);
  const key = await req<{ publicKeyPem: string; keyId: string; algorithm: string }>("GET", "/api/signing/public-key");
  // With FEA results the package is far above the global 4 MB body limit; the verify route has its own limit.
  assert.ok(JSON.stringify(pkg).length > 4_000_000, "package carries the FEA result files");
  // Sealed once: a second download returns the same bytes (and the same time-stamp / archived version).
  const again = await req<ReleasePackage>("GET", `/api/releases/${rel.id}/package`);
  assert.equal(again.manifestSha256, pkg.manifestSha256); assert.equal(again.signature.value, pkg.signature.value);
  if (config.tsaUrl) assert.ok(pkg.timestamp && again.timestamp?.serial === pkg.timestamp.serial, "RFC 3161 token is embedded once");
  const result = await req<Awaited<ReturnType<typeof verifySealedPackage>>>("POST", "/api/packages/verify", { package: pkg, trustedPublicKeyPem: key.publicKeyPem });
  assert.equal(result.valid, true); assert.equal(result.signer.trusted, true);
  if (config.tsaUrl) assert.ok(result.timestamp?.genTime, "time-stamp verifies against the CA bundle");
  assert.ok(Object.keys(pkg.files).some(f => f.endsWith("part.step")), "native STEP is inside the package");
  assert.ok(Object.keys(pkg.files).some(f => f.endsWith("bracket-fine.frd")), "CalculiX results are inside the package");
  const offline = verifyPackage(pkg, key.publicKeyPem);
  const tampered = structuredClone(pkg); const step = Object.keys(tampered.files).find(f => f.endsWith("part.step"))!;
  tampered.files[step].contentBase64 = Buffer.from("tampered").toString("base64");
  const rejected = await app.inject({ method: "POST", url: "/api/packages/verify", payload: JSON.stringify({ package: tampered }), headers: { host, "content-type": "application/json" } });
  assert.equal(rejected.statusCode, 422);
  const report = { schema: "pai-package-e2e-1", checkedAt: new Date().toISOString(), result: "passed", release: rel.number, files: offline.files,
    signer: offline.signer, timestamp: result.timestamp, seal: (await req<{ releaseSeals: unknown[] }>("GET", "/api/state")).releaseSeals.at(-1), bytes: JSON.stringify(pkg).length, tamperedRejected: rejected.json().error };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "package-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
