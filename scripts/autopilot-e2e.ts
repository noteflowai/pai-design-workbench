/**
 * Live autopilot qualification in-process (real model through the bounded executor; spends ledger attempts):
 * the compact 6202 housing fails the bolt edge rule, a grant and goal are issued, and one autopilot round asks the
 * engines in PROFILES (default: the three Kiro keys, i.e. the extended domain-data class) for a fix that the native
 * checks then judge. MAX_ROUNDS bounds ledger use (default 1). Runs on the hosted instance via tools/hosted_e2e.sh.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";

const config = configuration();
const state = join(config.state, "autopilot-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const headers = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
const j = async <T>(method: "GET" | "POST", url: string, payload?: unknown): Promise<T> => {
  let r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers });
  for (let i = 0; r.statusCode === 202 && i < 400; i++) {
    await new Promise(done => setTimeout(done, 3000));
    r = await app.inject({ method: "GET", url: String(r.headers.location), headers });
  }
  assert.ok(r.statusCode < 300, `${url} ${r.statusCode} ${r.body.slice(0, 300)}`);
  return r.json() as T;
};
const profiles = (process.env.PROFILES ?? "kiro-primary,kiro-backup,kiro-backup2").split(",");
try {
  const st = await j<{ capabilities: { cad: { families: Record<string, Record<string, unknown>> } } }>("GET", "/api/state");
  const requirements = { ...st.capabilities.cad.families["pillow-block"], maxMassG: 175, maxEnvelopeMm: [92, 40, 60] };
  const p = await j<{ id: string }>("POST", "/api/projects", { title: "6202 housing autopilot qualification", intendedDecision: "Fix the bolt edge rule within mass and envelope",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const start = await j<{ verdict: string }>("POST", `/api/projects/${p.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "pillow-block-compact", requirements });
  assert.equal(start.verdict, "rejected");
  const grant = await j<{ id: string }>("POST", `/api/projects/${p.id}/autonomy-grants`, { tools: ["cad-review", "cad-code"], maxRuns: 2, hours: 1, note: "autopilot qualification" });
  const t0 = Date.now();
  const a = await j<{ id: string; outcome?: string; state: string; rounds: { round: number; planId?: string; tool?: string; verdict?: string; failing?: { id: string; observed: unknown }[]; note?: string }[] }>(
    "POST", `/api/projects/${p.id}/autopilot`, { requestId: randomUUID(), grantId: grant.id, maxRounds: Number(process.env.MAX_ROUNDS ?? 1), profiles,
      goal: "Make the 6202 pillow-block housing pass every frozen check without relaxing anything: mass at most 175 g and footprint within 92 x 40 x 60 mm. "
        + "In cad-1 the compact housing (88 mm base, M8 holes 76 mm apart) fails hole-edge-distance (6 mm < 13.5 mm). Propose a cad-review plan with variant parametric, "
        + "family pillow-block and bounded parameters that keeps the Ø35 H7 seat (seatDiameter 35.012); estimate edge distance and mass first." });
  // The executor's own request record names the class it ran under.
  const planId = a.rounds.find(r => r.planId)?.planId;
  let kind: string | undefined, attempts: unknown[] = [];
  if (planId) {
    const runs = join(state, "ai", planId, "native-state", "runs", `pai-ai-${planId}`);
    kind = JSON.parse(await readFile(join(state, "ai", planId, "request.json"), "utf8")).kind;
    for (const n of (await readdir(runs).catch(() => [] as string[])).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      const r = JSON.parse(await readFile(join(runs, n), "utf8"));
      attempts.push({ profile: r.requested?.profile, status: r.status, errorKind: r.error?.kind ?? null, effects: r.effects, answerChars: (r.answer ?? "").length,
        launchEvidence: r.launch_evidence?.state ?? null });
    }
  }
  const report = { schema: "pai-autopilot-e2e-1", checkedAt: new Date().toISOString(), profiles, kind, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    outcome: a.outcome ?? a.state, rounds: a.rounds.map(r => ({ round: r.round, tool: r.tool, verdict: r.verdict, failing: r.failing?.map(f => `${f.id}=${JSON.stringify(f.observed)}`), note: r.note })),
    attempts, result: a.outcome === "goal-met" ? "passed" : "not-met", physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "autopilot-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
