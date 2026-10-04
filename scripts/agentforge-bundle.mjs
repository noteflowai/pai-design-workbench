#!/usr/bin/env node
// The AgentForge integration bundle: everything the base example installs, owned here, listed with digests.
//   node scripts/agentforge-bundle.mjs           # write integrations/agentforge/bundle.json
//   node scripts/agentforge-bundle.mjs --check   # fail if bundle.json is out of date
// AgentForge pins ONE value — the SHA-256 of bundle.json at a commit — and verifies every listed file against it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../integrations/agentforge/", import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
const files = walk(ROOT).map(f => relative(ROOT, f)).filter(f => f !== "bundle.json" && f !== "README.md").sort();
const skill = readFileSync(join(ROOT, "skills/pai-industrial-design/SKILL.md"), "utf8");
const bundle = {
  schema: "pai-agentforge-bundle-1",
  skillVersion: /^version:\s*"?([^"\n]+)"?$/m.exec(skill)[1],
  profile: "mcp-profile.json", skill: "skills/pai-industrial-design", evalTasks: "eval/tasks",
  files: Object.fromEntries(files.map(f => [f, createHash("sha256").update(readFileSync(join(ROOT, f))).digest("hex")])),
};
const text = JSON.stringify(bundle, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(join(ROOT, "bundle.json"), "utf8") !== text) { console.error("integrations/agentforge/bundle.json is out of date: run node scripts/agentforge-bundle.mjs"); process.exit(1); }
  console.log(`bundle OK: ${files.length} files, sha256 ${createHash("sha256").update(text).digest("hex")}`);
} else { writeFileSync(join(ROOT, "bundle.json"), text); console.log(`wrote bundle.json (${files.length} files)`); }
