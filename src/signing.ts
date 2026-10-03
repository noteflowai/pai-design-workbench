/**
 * Signed release packages: every approved release can be exported as one self-contained file that a third party
 * can verify offline — native artifacts, the evidence record, the release decision and a signed manifest.
 *
 * Signing:
 * - Hosted: an AWS KMS asymmetric key (ECC_NIST_P256, ECDSA_SHA_256 over the manifest digest). The private key never
 *   leaves KMS; the instance role may only Sign / GetPublicKey on that one key.
 * - Local: an Ed25519 key generated in private state (owner-only). It identifies this workstation, not an organisation.
 *
 * Verification recomputes every file digest, the record digest and the manifest digest, then checks the signature.
 * It reports `trusted` only when the caller pins the expected public key; a valid signature alone proves integrity
 * under that key, not who holds it. Nothing here is physical validation.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as cryptoVerify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { canonical, DomainError, sha256 } from "./domain.js";

export interface Signer { keyId: string; algorithm: "ECDSA_P256_SHA256" | "ED25519"; publicKeyPem: string; sign(digest: Buffer): Promise<Buffer> }

let cached: Promise<Signer> | undefined;
export function signer(config: Config): Promise<Signer> {
  cached ??= config.signingKmsKeyId ? kmsSigner(config.signingKmsKeyId) : localSigner(config.state);
  return cached;
}

async function kmsSigner(keyId: string): Promise<Signer> {
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import("@aws-sdk/client-kms");
  const kms = new KMSClient({});
  const pub = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (pub.KeySpec !== "ECC_NIST_P256" || !pub.SigningAlgorithms?.includes("ECDSA_SHA_256") || !pub.PublicKey) {
    throw new DomainError("SIGNING_KEY", "The KMS signing key must be ECC_NIST_P256 with ECDSA_SHA_256", 503);
  }
  const publicKeyPem = createPublicKey({ key: Buffer.from(pub.PublicKey), format: "der", type: "spki" }).export({ format: "pem", type: "spki" }).toString();
  return { keyId: pub.KeyId!, algorithm: "ECDSA_P256_SHA256", publicKeyPem,
    async sign(digest) {
      const r = await kms.send(new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }));
      if (!r.Signature) throw new DomainError("SIGNING_FAILED", "KMS returned no signature", 502);
      return Buffer.from(r.Signature);
    } };
}

async function localSigner(state: string): Promise<Signer> {
  const dir = join(state, "signing"), file = join(dir, "ed25519-private.pem");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let pem: string;
  try { pem = await readFile(file, "utf8"); }
  catch {
    pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await writeFile(file, pem, { mode: 0o600, flag: "wx" }).catch(async () => { pem = await readFile(file, "utf8"); });
  }
  const key = createPrivateKey(pem);
  const publicKeyPem = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  return { keyId: `local-ed25519:${sha256(publicKeyPem).slice(0, 16)}`, algorithm: "ED25519", publicKeyPem,
    async sign(digest) { return edSign(null, digest, key); } };
}

const FileEntry = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), contentBase64: z.string() }).strict();
export const ReleasePackage = z.object({
  schema: z.literal("pai-release-package-1"),
  release: z.object({ id: z.string(), number: z.string(), title: z.string(), maturity: z.string(), projectId: z.string(), projectRevision: z.number().int(),
    requirementDigest: z.string(), evidenceKind: z.string(), runId: z.string(), scope: z.string(), history: z.array(z.unknown()), admission: z.array(z.unknown()) }).passthrough(),
  subject: z.object({ kind: z.string(), recordId: z.string(), verdict: z.string().nullable(), requirementDigest: z.string(), recordSha256: z.string() }).strict(),
  record: z.string(), files: z.record(z.string(), FileEntry),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.object({ algorithm: z.enum(["ECDSA_P256_SHA256", "ED25519"]), keyId: z.string(), publicKeyPem: z.string(), value: z.string(), signedAt: z.string() }).strict(),
  physicalValidation: z.literal(false),
}).strict();
export type ReleasePackage = z.infer<typeof ReleasePackage>;

const manifest = (p: Omit<ReleasePackage, "manifestSha256" | "signature">) => canonical({
  schema: p.schema, release: p.release, subject: p.subject, files: Object.fromEntries(Object.entries(p.files).map(([k, f]) => [k, { sha256: f.sha256, bytes: f.bytes }])),
  physicalValidation: p.physicalValidation });

export const MAX_PACKAGE_BYTES = 40_000_000;
/** Build and sign a package from an approved release, its record and the native files (already digest-checked). */
export async function buildPackage(config: Config, release: ReleasePackage["release"], record: { id: string; verdict?: string | null; requirementDigest: string },
  files: Record<string, Buffer>): Promise<ReleasePackage> {
  if (release.maturity !== "released") throw new DomainError("NOT_RELEASED", "Only an approved release can be packaged", 409);
  const total = Object.values(files).reduce((n, b) => n + b.length, 0);
  if (total > MAX_PACKAGE_BYTES) throw new DomainError("PACKAGE_SIZE", "Native artifacts exceed the package limit", 413);
  const recordText = JSON.stringify(record, null, 2);
  const body = { schema: "pai-release-package-1" as const, release,
    subject: { kind: release.evidenceKind, recordId: record.id, verdict: record.verdict ?? null, requirementDigest: record.requirementDigest, recordSha256: sha256(recordText) },
    record: recordText, files: Object.fromEntries(Object.entries(files).sort().map(([k, b]) => [k, { sha256: sha256(b), bytes: b.length, contentBase64: b.toString("base64") }])),
    physicalValidation: false as const };
  const text = manifest(body), digest = createHash("sha256").update(text).digest();
  const s = await signer(config);
  const value = await s.sign(digest);
  return { ...body, manifestSha256: digest.toString("hex"),
    signature: { algorithm: s.algorithm, keyId: s.keyId, publicKeyPem: s.publicKeyPem, value: value.toString("base64"), signedAt: new Date().toISOString() } };
}

/** Offline verification. `trustedPublicKeyPem` pins the signer; without it the result says the signer is untrusted. */
export function verifyPackage(input: unknown, trustedPublicKeyPem?: string) {
  const p = ReleasePackage.parse(input);
  for (const [name, f] of Object.entries(p.files)) {
    const b = Buffer.from(f.contentBase64, "base64");
    if (b.length !== f.bytes || sha256(b) !== f.sha256) throw new DomainError("PACKAGE_FILE", `Modified file: ${name}`, 422);
  }
  if (sha256(p.record) !== p.subject.recordSha256) throw new DomainError("PACKAGE_RECORD", "Evidence record was modified", 422);
  const record = JSON.parse(p.record) as { id?: string; requirementDigest?: string; verdict?: string; files?: Record<string, string> };
  if (record.id !== p.subject.recordId || record.id !== p.release.runId || record.requirementDigest !== p.subject.requirementDigest) {
    throw new DomainError("PACKAGE_CONTEXT", "Record, subject and release identity disagree", 422);
  }
  // Every file named by the record's own digest map must be present with that digest.
  for (const [name, digest] of Object.entries(record.files ?? {})) {
    if (p.files[name]?.sha256 !== digest) throw new DomainError("PACKAGE_FILE", `File missing or different from the record's digest: ${name}`, 422);
  }
  const { manifestSha256, signature, ...body } = p;
  const digest = createHash("sha256").update(manifest(body)).digest();
  if (digest.toString("hex") !== manifestSha256) throw new DomainError("PACKAGE_MANIFEST", "Manifest digest mismatch", 422);
  const key = createPublicKey(signature.publicKeyPem);
  const ok = signature.algorithm === "ED25519" ? cryptoVerify(null, digest, key, Buffer.from(signature.value, "base64"))
    // KMS signs the SHA-256 digest; verify the DER ECDSA signature over that same digest.
    : cryptoVerify(null, digest, { key, dsaEncoding: "der" }, Buffer.from(signature.value, "base64"))
      || cryptoVerify("sha256", Buffer.from(manifest(body)), { key, dsaEncoding: "der" }, Buffer.from(signature.value, "base64"));
  if (!ok) throw new DomainError("PACKAGE_SIGNATURE", "Signature does not verify", 422);
  const pinned = trustedPublicKeyPem ? createPublicKey(trustedPublicKeyPem).export({ format: "pem", type: "spki" }).toString() === key.export({ format: "pem", type: "spki" }).toString() : undefined;
  return { valid: true as const, release: p.release.number, kind: p.subject.kind, recordId: p.subject.recordId, verdict: p.subject.verdict, files: Object.keys(p.files).length,
    signer: { keyId: signature.keyId, algorithm: signature.algorithm, trusted: pinned ?? false, pinned: pinned !== undefined }, physicalValidated: false as const };
}
