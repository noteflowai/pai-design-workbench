/**
 * Solver for the AgentForge physical-reasoning golden task (examples/pai-workbench/eval), backed by the real model
 * through the bounded executor (shared ledger, no retries). Run in the task workspace by the base eval harness:
 *   node examples/pai-workbench/eval/run.mjs --command "node --env-file=<wb>/.state/demo.env --import tsx <wb>/scripts/eval-physics-solver.ts"
 * The model returns a power-law scaling (exponents + rationale) as JSON, never code; this script writes estimate.mjs
 * from those numbers, so no generated code is executed. One executor attempt per run.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configuration } from "../src/config.js";
import { enabledProfiles, runController } from "../src/controller.js";

const ws = process.cwd();
const config = configuration();
const readme = await readFile(join(ws, "README.md"), "utf8"), reference = await readFile(join(ws, "reference.json"), "utf8");
const prompt = [
  "You are a mechanical engineer. Predict how the motor-axis deflection of this bracket scales with its parameters.",
  "Answer with ONE JSON object and nothing else:",
  '{"thicknessExponent": a, "widthExponent": b, "heightExponent": c, "rationale": "<= 600 chars"}',
  "meaning deflection = d_ref * (t/t_ref)^a * (W/W_ref)^b * (H/H_ref)^c, where d_ref is the measured reference.",
  "Reason from plate bending, the ribs at the side edges, and where the load enters. Exponents are bounded to [-6, 6].",
  "<bracket>", readme, "</bracket>", "<reference>", reference, "</reference>",
].join("\n");
const id = `pai-eval-${randomUUID()}`;
const dir = resolve(config.state, "eval", id);
await mkdir(dir, { recursive: true, mode: 0o700 });
const r = await runController(config, dir, id, prompt, { profiles: enabledProfiles(config).slice(0, 1), timeoutSeconds: 60 });
if (r.action !== "done" || !r.answer) throw new Error(`executor: ${r.action} ${r.reason ?? ""}`);
const text = r.answer.slice(r.answer.indexOf("{"), r.answer.lastIndexOf("}") + 1);
const out = z.object({ thicknessExponent: z.number().min(-6).max(6), widthExponent: z.number().min(-6).max(6), heightExponent: z.number().min(-6).max(6),
  rationale: z.string().max(2000) }).parse(JSON.parse(text));
await writeFile(join(ws, "estimate.mjs"), `// Generated from the model's scaling exponents (${r.engine?.profile} · ${r.engine?.model} · ${r.engine?.engineVersion}).
import { readFileSync } from 'node:fs';
const ref = JSON.parse(readFileSync(new URL('./reference.json', import.meta.url), 'utf8'));
export function estimate({ thickness, width, plateHeight }) {
  const p = ref.parameters;
  return ref.deflectionMm * (thickness / p.thickness) ** ${out.thicknessExponent} * (width / p.width) ** ${out.widthExponent} * (plateHeight / p.plateHeight) ** ${out.heightExponent};
}
`);
await writeFile(join(config.state, "eval", `${id}.json`), JSON.stringify({ engine: r.engine, exponents: out, attempts: r.attempts.map(a => ({ profile: a.profile, status: a.status })) }, null, 2));
console.log(JSON.stringify({ engine: r.engine, ...out }));
