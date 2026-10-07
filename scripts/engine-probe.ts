/**
 * One bounded engine call to confirm a deployment can reach a model (npm run probe:engine; PROBE_PROFILE=claude).
 * One ledger attempt, never retried; the tiny prompt asks for a fixed JSON answer. Writes evidence/engine-probe.json
 * with the executor action, the attempt receipts and whether the answer parsed. No answer text beyond that is kept.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config.js";
import { enabledProfiles, runController, settleRun, type Profile } from "../src/controller.js";

const config = configuration();
const profile = (process.env.PROBE_PROFILE ?? enabledProfiles(config)[0]) as Profile;
if (!enabledProfiles(config).includes(profile)) throw new Error(`profile ${profile} is not enabled here (${enabledProfiles(config).join(", ")})`);
const id = `pai-probe-${randomUUID()}`;
const dir = resolve(config.state, "probe", id);
await mkdir(dir, { recursive: true, mode: 0o700 });
// The executor requires Kiro requests to keep its key order (primary, backup, backup2): probing a later Kiro key
// sends the chain up to it, so an exhausted primary falls through to the key under test within one bounded run.
const kiro = ["kiro-primary", "kiro-backup", "kiro-backup2"];
const profiles = (kiro.includes(profile) ? kiro.slice(0, kiro.indexOf(profile) + 1) : [profile]) as Profile[];
const r = await runController(config, dir, id, 'Reply with exactly this JSON and nothing else: {"probe":"ok"}', { profiles, timeoutSeconds: 60 });
const parsed = /\{\s*"probe"\s*:\s*"ok"\s*\}/.test(r.answer ?? "");
// The probe's prompt is a fixed constant and its answer is never executed, so the probe settles its own unknown-effect
// attempt through the executor (which still checks the receipt); otherwise each probe would hold a ledger slot forever.
const settlements = r.action === "reconcile" ? await settleRun(config, dir, id, "engine-probe",
  "Fixed probe prompt asking for a constant JSON answer; the answer is only pattern-matched, never executed.") : [];
const report = { schema: "pai-engine-probe-1", checkedAt: new Date().toISOString(), profile, action: r.action, reason: r.reason ?? null, answered: parsed,
  attempts: r.attempts.map(a => ({ profile: a.profile, status: a.status, errorKind: a.errorKind, model: a.model })), engine: r.engine ?? null,
  settlements, result: parsed ? "passed" : "failed" };
await mkdir(join(config.state, "evidence"), { recursive: true });
await writeFile(join(config.state, "evidence", "engine-probe.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!parsed) process.exitCode = 1;
