/**
 * Release seals: trusted time and write-once retention for signed release packages.
 *
 * - Trusted time: an RFC 3161 time-stamp token over SHA-256(signature value), from a public time-stamping authority
 *   (TSA). This is the CAdES-T pattern: it proves the signature existed at the TSA's time, independent of our clock.
 *   Only the 32-byte digest leaves the host. Tokens are created and verified with OpenSSL (`openssl ts`), not with
 *   our own ASN.1 code.
 * - Write-once retention: the sealed package is put into an S3 bucket with Object Lock, with an explicit per-object
 *   mode (COMPLIANCE by default: nobody, including the account root, can shorten it) and retain-until date. The
 *   applied lock and checksum are read back, and the S3 version ID is recorded.
 *
 * Both are opt-in (PAI_TSA_URL, PAI_PACKAGE_ARCHIVE_BUCKET); without them the package is still signed.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { command } from "./adapters.js";
import type { Config } from "./config.js";
import { DomainError } from "./domain.js";

export const Timestamp = z.object({
  standard: z.literal("RFC3161"), tsa: z.string().url(), hashAlgorithm: z.literal("SHA-256"),
  /** SHA-256 of the decoded signature value: the imprint the token commits to. */
  messageImprint: z.string().regex(/^[a-f0-9]{64}$/), genTime: z.string(), serial: z.string(), tokenBase64: z.string().max(40_000),
}).strict();
export type Timestamp = z.infer<typeof Timestamp>;
export const Archive = z.object({ store: z.literal("s3-object-lock"), bucket: z.string(), key: z.string(), versionId: z.string(),
  mode: z.enum(["COMPLIANCE", "GOVERNANCE"]), retainUntil: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Archive = z.infer<typeof Archive>;

const DEFAULT_CA = "/etc/ssl/certs/ca-certificates.crt";
const openssl = async (args: string[], cwd: string) => {
  const r = await command("openssl", args, cwd, undefined, 30_000);
  if (r.exitCode !== 0) throw new DomainError("TSA_OPENSSL", `openssl ${args[0]} ${args[1]} failed: ${r.stderr.trim().slice(0, 200)}`, 502);
  return r.stdout;
};

/** Request a time-stamp token for `signature` (raw bytes). Fails closed: a bad or unverifiable token is an error. */
export async function timestamp(config: Config, signature: Buffer): Promise<Timestamp> {
  if (!config.tsaUrl) throw new DomainError("TSA_NOT_CONFIGURED", "Set PAI_TSA_URL", 503);
  const dir = await mkdtemp(join(tmpdir(), "pai-tsa-"));
  try {
    await writeFile(join(dir, "data"), signature);
    await openssl(["ts", "-query", "-data", "data", "-sha256", "-cert", "-out", "q.tsq"], dir);
    const r = await fetch(config.tsaUrl, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body: await readFile(join(dir, "q.tsq")),
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!r.ok || r.headers.get("content-type")?.split(";")[0].trim() !== "application/timestamp-reply") {
      throw new DomainError("TSA_RESPONSE", `Time-stamping authority answered ${r.status}`, 502);
    }
    const reply = Buffer.from(await r.arrayBuffer());
    if (reply.length > 30_000) throw new DomainError("TSA_RESPONSE", "Time-stamp reply too large", 502);
    await writeFile(join(dir, "r.tsr"), reply);
    // The reply must match our query (nonce, imprint) and chain to the trusted CA bundle.
    await openssl(["ts", "-verify", "-queryfile", "q.tsq", "-in", "r.tsr", "-CAfile", config.tsaCaFile ?? DEFAULT_CA], dir);
    await openssl(["ts", "-reply", "-in", "r.tsr", "-token_out", "-out", "token.der"], dir);
    const token = await readFile(join(dir, "token.der"));
    const info = await openssl(["ts", "-reply", "-in", "token.der", "-token_in", "-text"], dir);
    return { standard: "RFC3161", tsa: config.tsaUrl, hashAlgorithm: "SHA-256", messageImprint: createHash("sha256").update(signature).digest("hex"),
      genTime: /Time stamp: (.+)/.exec(info)?.[1]?.trim() ?? "unknown", serial: /Serial number: (.+)/.exec(info)?.[1]?.trim() ?? "unknown", tokenBase64: token.toString("base64") };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Offline verification of a token against the signature it claims to cover. `caFile` is the trust anchor bundle
 * (the system bundle by default). Returns the TSA time; throws when the token does not verify.
 */
export async function verifyTimestamp(ts: Timestamp, signature: Buffer, caFile = DEFAULT_CA): Promise<{ genTime: string; tsa: string }> {
  const parsed = Timestamp.parse(ts);
  if (createHash("sha256").update(signature).digest("hex") !== parsed.messageImprint) throw new DomainError("PACKAGE_TIMESTAMP", "Time-stamp covers a different signature", 422);
  const dir = await mkdtemp(join(tmpdir(), "pai-tsa-"));
  try {
    await writeFile(join(dir, "data"), signature);
    await writeFile(join(dir, "token.der"), Buffer.from(parsed.tokenBase64, "base64"));
    const r = await command("openssl", ["ts", "-verify", "-data", "data", "-in", "token.der", "-token_in", "-CAfile", caFile], dir, undefined, 30_000);
    if (r.exitCode !== 0 || !/Verification: OK/.test(r.stdout)) throw new DomainError("PACKAGE_TIMESTAMP", "Time-stamp token does not verify", 422);
    return { genTime: parsed.genTime, tsa: parsed.tsa };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Put the sealed package into the Object Lock bucket; returns the retained version. Never overwrites: versions only. */
type S3Like = { send(command: unknown): Promise<Record<string, unknown>> };
export async function archive(config: Config, key: string, body: Buffer, client?: S3Like): Promise<Archive> {
  if (!config.packageArchiveBucket) throw new DomainError("ARCHIVE_NOT_CONFIGURED", "Set PAI_PACKAGE_ARCHIVE_BUCKET", 503);
  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = (client ?? new S3Client({})) as { send(c: unknown): Promise<any> };
  const retainUntil = new Date(Date.now() + config.packageRetentionDays * 86_400_000);
  const sha = createHash("sha256").update(body).digest();
  const put = await s3.send(new PutObjectCommand({ Bucket: config.packageArchiveBucket, Key: key, Body: body, ContentType: "application/json",
    ChecksumSHA256: sha.toString("base64"), ObjectLockMode: config.packageLockMode, ObjectLockRetainUntilDate: retainUntil }));
  if (!put.VersionId) throw new DomainError("ARCHIVE_VERSION", "The archive bucket is not versioned; Object Lock requires versioning", 502);
  // Read back what S3 actually applied rather than trusting the request.
  const head = await s3.send(new HeadObjectCommand({ Bucket: config.packageArchiveBucket, Key: key, VersionId: put.VersionId }));
  if (head.ObjectLockMode !== config.packageLockMode || !head.ObjectLockRetainUntilDate || new Date(head.ObjectLockRetainUntilDate) < retainUntil) {
    throw new DomainError("ARCHIVE_LOCK", "Object Lock retention was not applied as requested", 502);
  }
  if (head.ChecksumSHA256 && head.ChecksumSHA256 !== sha.toString("base64")) throw new DomainError("ARCHIVE_CHECKSUM", "Archived object checksum differs", 502);
  return { store: "s3-object-lock", bucket: config.packageArchiveBucket, key, versionId: put.VersionId, mode: head.ObjectLockMode as Archive["mode"],
    retainUntil: new Date(head.ObjectLockRetainUntilDate).toISOString(), sha256: sha.toString("hex") };
}
