/** Offline release-package verification (signature, file digests, RFC 3161 time-stamp): npm run verify:package -- <package.json> [trusted-public-key.pem] */
import { readFile } from "node:fs/promises";
import { verifySealedPackage } from "../src/signing.js";
const [file, keyFile] = process.argv.slice(2);
if (!file) { console.error("usage: npm run verify:package -- <package.json> [trusted-public-key.pem]"); process.exit(2); }
try {
  // The RFC 3161 token (if any) is checked against PAI_TSA_CA_FILE or the system CA bundle.
  const result = await verifySealedPackage(JSON.parse(await readFile(file, "utf8")), keyFile ? await readFile(keyFile, "utf8") : undefined, process.env.PAI_TSA_CA_FILE);
  console.log(JSON.stringify(result, null, 2));
  if (keyFile && !result.signer.trusted) process.exit(1);
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
