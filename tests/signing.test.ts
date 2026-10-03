import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { buildPackage, signer, verifyPackage } from "../src/signing.js";
import { sha256 } from "../src/domain.js";

test("a signed release package verifies offline and any change to file, record or release is detected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-sign-"));
  try {
    const config = { ...configuration(), state: dir, signingKmsKeyId: undefined };
    const step = Buffer.from("ISO-10303-21;\nSTEP fixture\n"), fea = Buffer.from(JSON.stringify({ checks: [] }));
    const record = { id: "rec-1", verdict: "accepted-cad-part", requirementDigest: "a".repeat(64), files: { "candidate/part.step": sha256(step), "candidate/fea.json": sha256(fea) } };
    const release = { id: "rel-1", number: "R1", title: "Bracket", maturity: "released", projectId: "p", projectRevision: 1, requirementDigest: "a".repeat(64),
      evidenceKind: "cad-part", runId: "rec-1", scope: "x", history: [], admission: [] };
    const pkg = await buildPackage(config, release, record, { "candidate/part.step": step, "candidate/fea.json": fea });
    const key = (await signer(config)).publicKeyPem;
    const ok = verifyPackage(pkg, key);
    assert.equal(ok.valid, true); assert.equal(ok.signer.trusted, true); assert.equal(ok.files, 2);
    assert.equal(verifyPackage(pkg).signer.trusted, false, "an unpinned signer is never reported as trusted");
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    assert.equal(verifyPackage(pkg, other).signer.trusted, false);
    const clone = () => JSON.parse(JSON.stringify(pkg));
    const a = clone(); a.files["candidate/part.step"].contentBase64 = Buffer.from("tampered").toString("base64");
    assert.throws(() => verifyPackage(a), /Modified file|PACKAGE/);
    const b = clone(); b.release.maturity = "in-review";
    assert.throws(() => verifyPackage(b), /Manifest digest/);
    const c = clone(); c.record = c.record.replace("accepted-cad-part", "accepted-cad-parX");
    assert.throws(() => verifyPackage(c), /record was modified/);
    const d = clone(); delete d.files["candidate/fea.json"];
    assert.throws(() => verifyPackage(d), /missing|Manifest/);
    const e = clone(); e.signature.value = Buffer.alloc(64).toString("base64");
    assert.throws(() => verifyPackage(e), /Signature/);
    await assert.rejects(buildPackage(config, { ...release, maturity: "in-review" }, record, {}), /approved release/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
