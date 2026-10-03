/** Offline release-package verification: npm run verify:package -- <package.json> [trusted-public-key.pem] */
import { readFile } from "node:fs/promises";
import { verifyPackage } from "../src/signing.js";
const [file, keyFile] = process.argv.slice(2);
if (!file) { console.error("usage: npm run verify:package -- <package.json> [trusted-public-key.pem]"); process.exit(2); }
try {
  const result = verifyPackage(JSON.parse(await readFile(file, "utf8")), keyFile ? await readFile(keyFile, "utf8") : undefined);
  console.log(JSON.stringify(result, null, 2));
  if (keyFile && !result.signer.trusted) process.exit(1);
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
