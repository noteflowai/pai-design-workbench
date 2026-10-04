/**
 * Blind visual-review control: the model sees recorded inspection-camera previews with neutral letters only (no
 * variant name, record, check result or file path) and judges line of sight; its answers are scored against the
 * native BVH ray check (camera-visibility) of the same record. Two executor runs of three images each, on the shared
 * admission ledger, never retried. Measures reading the image, not the solver: the native check stays the verdict.
 *
 *   PAI_CONTROL_ROOT=… PAI_CONTROLLER_ENTRYPOINT=… node --env-file=.state/demo.env --import tsx scripts/visual-blind.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { configuration } from "../src/config.js";
import { enabledProfiles, runController } from "../src/controller.js";

const config = configuration();
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PER_VARIANT = 3, PER_RUN = 3;

// Recorded scene previews with their native verdict, one per distinct image digest.
async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name === "preview.png" && /\/scenes\/[^/]+\/(baseline|candidate)\/preview\.png$/.test(p)) yield p;
  }
}
const Checks = z.object({ variant: z.string(), checks: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()) }).passthrough();
const pool = new Map<string, { visible: boolean; variant: string; data: Buffer }>();
for await (const path of walk(config.state)) {
  const checks = Checks.safeParse(JSON.parse(await readFile(join(path, "..", "checks.json"), "utf8").catch(() => "{}")));
  if (!checks.success || !["clear", "occluded"].includes(checks.data.variant)) continue;
  const visibility = checks.data.checks.find(c => c.id === "camera-visibility");
  if (!visibility) continue;
  const data = await readFile(path);
  if (data.length <= 1_500_000) pool.set(sha(data), { visible: visibility.passed, variant: checks.data.variant, data });
}
// Deterministic selection (lowest digests) and order (digest of digest), balanced between the two outcomes.
const pick = (visible: boolean) => [...pool].filter(([, x]) => x.visible === visible).sort(([a], [b]) => a.localeCompare(b)).slice(0, PER_VARIANT);
const items = [...pick(true), ...pick(false)].map(([digest, x]) => ({ digest, ...x }))
  .sort((a, b) => sha(Buffer.from(a.digest)).localeCompare(sha(Buffer.from(b.digest))));
assert.equal(items.length, 2 * PER_VARIANT, "need recorded clear and occluded scene previews (npm run test:native)");

const Answer = z.record(z.string(), z.object({ visible: z.boolean(), reason: z.string().max(1000) }));
const runs = [];
for (let k = 0; k < items.length; k += PER_RUN) {
  const batch = items.slice(k, k + PER_RUN), letters = batch.map((_, i) => String.fromCharCode(65 + i));
  const prompt = [
    `You receive ${batch.length} images, ${letters.join(", ")} in order. Each is the view of a fixed inspection camera in a robot work cell,`,
    "which must see the work area (a fixture with a small part on it). For each image, judge from the image alone whether the camera has",
    "an unobstructed line of sight to that work area, or whether an object blocks the view. Answer with ONE JSON object and nothing else:",
    `{${letters.map(l => `"${l}": {"visible": true|false, "reason": "<= 200 chars, what you see"}`).join(", ")}}`,
  ].join("\n");
  const id = `pai-visual-${randomUUID()}`, dir = resolve(config.state, "eval", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const r = await runController(config, dir, id, prompt, { profiles: enabledProfiles(config).slice(0, 1), timeoutSeconds: 60,
    images: batch.map(x => ({ mediaType: "image/png" as const, data: x.data })) });
  if (r.action !== "done" || !r.answer) { runs.push({ runId: id, action: r.action, reason: r.reason, answered: false }); break; } // no retry
  const answer = Answer.parse(JSON.parse(r.answer.slice(r.answer.indexOf("{"), r.answer.lastIndexOf("}") + 1)));
  runs.push({ runId: id, action: r.action, engine: r.engine, reportSha256: r.reportSha256, answered: true,
    images: batch.map((x, i) => ({ sha256: x.digest, native: x.visible, model: answer[letters[i]]?.visible ?? null, reason: answer[letters[i]]?.reason ?? null })) });
}
const scored = runs.flatMap(r => r.images ?? []);
const tp = scored.filter(x => !x.native && x.model === false).length, fp = scored.filter(x => x.native && x.model === false).length;
const fn = scored.filter(x => !x.native && x.model !== false).length, correct = scored.filter(x => x.model === x.native).length;
const report = { schema: "pai-visual-blind-1", checkedAt: new Date().toISOString(),
  task: "line of sight from the inspection camera; ground truth = native BVH ray check camera-visibility of the same record",
  blinding: "neutral letters only; no variant name, record id, check result or path in the prompt; images pinned by SHA-256 in the executor request",
  runs, scored: scored.length, correct, accuracy: scored.length ? correct / scored.length : null,
  occlusion: { truePositive: tp, falsePositive: fp, falseNegative: fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null },
  limits: "small sample; preview is the inspection camera's own view, so a blocking object fills the frame (an easy case). Model judgement is advisory; the ray check is the verdict.",
  physicalValidation: false };
await mkdir(join(config.state, "evidence"), { recursive: true });
await writeFile(join(config.state, "evidence", "visual-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ scored: report.scored, accuracy: report.accuracy, occlusion: report.occlusion, runs: runs.map(r => r.action) }));
