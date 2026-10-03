import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { configuration } from "../src/config.js";
import { buildPackage, verifySealedPackage } from "../src/signing.js";
import { timestamp } from "../src/seal.js";
import { sha256 } from "../src/domain.js";

/** A throwaway RFC 3161 TSA: self-signed root + timeStamping leaf, answering with `openssl ts -reply`. */
async function localTsa(dir: string) {
  const sh = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  await writeFile(join(dir, "ext.cnf"), "[tsa]\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n"
    + "[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n");
  sh(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Test TSA Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  sh(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "tsa.key", "-out", "tsa.csr", "-subj", "/CN=Test TSA"]);
  sh(["x509", "-req", "-in", "tsa.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "tsa.pem", "-days", "2", "-extfile", "ext.cnf", "-extensions", "tsa"]);
  await writeFile(join(dir, "tsa.cnf"), `[tsa]\ndefault_tsa=t\n[t]\ndir=${dir}\nserial=${dir}/serial\ncrypto_device=builtin\nsigner_cert=${dir}/tsa.pem\nsigner_key=${dir}/tsa.key\n`
    + `signer_digest=sha256\ndefault_policy=1.2.3.4.1\ndigests=sha256\naccuracy=secs:1\nordering=yes\ntsa_name=no\ness_cert_id_chain=no\ness_cert_id_alg=sha256\ncerts=${dir}/tsa.pem\n`);
  await writeFile(join(dir, "serial"), "01\n");
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const q = join(dir, `q-${Date.now()}.tsq`); await writeFile(q, Buffer.concat(chunks));
    const out = join(dir, `r-${Date.now()}.tsr`);
    execFileSync("openssl", ["ts", "-reply", "-config", join(dir, "tsa.cnf"), "-queryfile", q, "-out", out], { cwd: dir, stdio: "pipe" });
    res.writeHead(200, { "content-type": "application/timestamp-reply" }); res.end(await readFile(out));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, ca: join(dir, "ca.pem"), close: () => server.close() };
}

test("RFC 3161: the seal time-stamps the signature, verifies offline, and binds to that exact signature", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-seal-"));
  const tsa = await localTsa(dir);
  try {
    const config = { ...configuration(), state: dir, signingKmsKeyId: undefined, tsaUrl: tsa.url, tsaCaFile: tsa.ca };
    const step = Buffer.from("ISO-10303-21;\n");
    const record = { id: "rec-1", verdict: "accepted-cad-part", requirementDigest: "a".repeat(64), files: { "candidate/part.step": sha256(step) } };
    const release = { id: "rel-1", number: "R1", title: "Bracket", maturity: "released", projectId: "p", projectRevision: 1, requirementDigest: "a".repeat(64),
      evidenceKind: "cad-part", runId: "rec-1", scope: "x", history: [], admission: [] };
    const pkg = await buildPackage(config, release, record, { "candidate/part.step": step });
    const sealed = { ...pkg, timestamp: await timestamp(config, Buffer.from(pkg.signature.value, "base64")) };
    const ok = await verifySealedPackage(sealed, undefined, tsa.ca);
    assert.ok(ok.timestamp?.genTime && ok.timestamp.genTime !== "unknown", "TSA time is reported");
    // The token commits to this signature only: moving it to another package is detected.
    const other = await buildPackage(config, { ...release, title: "Other" }, record, { "candidate/part.step": step });
    await assert.rejects(verifySealedPackage({ ...other, timestamp: sealed.timestamp }, undefined, tsa.ca), /different signature/);
    // A token that does not chain to the trusted anchors is rejected (system bundle does not contain the test root).
    await assert.rejects(verifySealedPackage(sealed, undefined, "/etc/ssl/certs/ca-certificates.crt"), /does not verify/);
    // A forged imprint field cannot rescue a token for another signature.
    const forged = { ...other, timestamp: { ...sealed.timestamp, messageImprint: sha256(Buffer.from(other.signature.value, "base64")) } };
    await assert.rejects(verifySealedPackage(forged, undefined, tsa.ca), /does not verify/);
  } finally { tsa.close(); await rm(dir, { recursive: true, force: true }); }
});

import { archive } from "../src/seal.js";
test("Object Lock archive: explicit mode and retain-until, read back; an unlocked or unversioned bucket fails closed", async () => {
  const config = { ...configuration(), packageArchiveBucket: "evidence-bucket", packageRetentionDays: 30, packageLockMode: "COMPLIANCE" as const };
  const body = Buffer.from('{"schema":"pai-release-package-1"}');
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const fake = (head: Record<string, unknown>, put: Record<string, unknown> = { VersionId: "v1" }) => ({ send: async (c: unknown) => {
    const cmd = c as { constructor: { name: string }; input: Record<string, unknown> }; sent.push({ name: cmd.constructor.name, input: cmd.input });
    return cmd.constructor.name === "PutObjectCommand" ? put : head; } });
  const later = new Date(Date.now() + 31 * 86_400_000);
  const a = await archive(config, "releases/p/R1.json", body, fake({ ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: later }));
  assert.equal(a.versionId, "v1"); assert.equal(a.mode, "COMPLIANCE"); assert.equal(a.sha256, sha256(body));
  const put = sent.find(x => x.name === "PutObjectCommand")!.input;
  assert.equal(put.ObjectLockMode, "COMPLIANCE"); assert.ok(put.ObjectLockRetainUntilDate instanceof Date); assert.ok(put.ChecksumSHA256);
  assert.equal(sent.find(x => x.name === "HeadObjectCommand")!.input.VersionId, "v1", "reads back the exact version");
  await assert.rejects(archive(config, "k", body, fake({})), /not applied/);
  await assert.rejects(archive(config, "k", body, fake({ ObjectLockMode: "GOVERNANCE", ObjectLockRetainUntilDate: later })), /not applied/);
  await assert.rejects(archive(config, "k", body, fake({ ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: later }, {})), /not versioned/);
  await assert.rejects(archive({ ...config, packageArchiveBucket: undefined }, "k", body), /ARCHIVE_NOT_CONFIGURED|PAI_PACKAGE_ARCHIVE_BUCKET/);
});

import { solverDataset } from "../src/dataset.js";
test("solver dataset: only solved points become rows, with inputs, outputs and the source record", () => {
  const records: Record<string, unknown[]> = {
    "cad-optimize": [{ id: "o1", projectId: "p", createdAt: "2026-10-04T00:00:00Z", request: { requirements: { structural: { forceN: 60, leverMm: 50 } } },
      result: { points: [
        { index: 1, origin: "reference", fidelity: "fea", parameters: { thickness: 4, width: 60, plateHeight: 46, pilotBore: 22.5 }, mass: 48.4, deflectionMm: 0.0478, stressMPa: 49 },
        { index: 2, origin: "screen", fidelity: "geometry", parameters: { thickness: 3, width: 46, plateHeight: 40, pilotBore: 22.5 }, mass: 30 },
        { index: 3, origin: "bo", fidelity: "fea", parameters: { thickness: 5, width: 58, plateHeight: 52, pilotBore: 22.5 }, mass: 66, deflectionMm: 0.024, remote: { jobId: "j" } }] } }],
    "cad-review": [], "aero-review": [{ id: "a1", projectId: "p", createdAt: "2026-10-04T01:00:00Z",
      baseline: { engine: "OpenFOAM v2512", parameters: { slantAngleDeg: 25, noseRadius: 0.1, length: 1.044, height: 0.288 } },
      cfd: { baseline: { frontalAreaM2: 0.112, runner: "batch", levels: [{ level: 3, cells: 61310, cd: 0.2575, cl: 0.2 }, { level: 4, cells: 219622, cd: 0.2341, cl: 0.21 }] } } }],
  };
  const d = solverDataset({ list: (kind: string) => records[kind] ?? [] } as never);
  assert.equal(d.rows, 4); assert.deepEqual(d.byDomain, { "structural-fea": 2, "aero-rans": 2 });
  assert.equal(d.data[1].fidelity, "fea-fine (AWS Batch)");
  assert.equal(d.data.find(r => r.domain === "aero-rans" && r.inputs.meshLevel === 4)!.outputs.cd, 0.2341);
  assert.match(d.sha256, /^[a-f0-9]{64}$/);
});
