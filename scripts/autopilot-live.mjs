// Live autopilot check against a running local workbench (real model through the bounded executor; spends ledger attempts).
//   PORT=4320 npm run start (with .state/demo.env), then: node scripts/autopilot-live.mjs
const B = "http://127.0.0.1:4320/api", H = { "content-type": "application/json", host: "127.0.0.1:4320", origin: "http://127.0.0.1:4320" };
const j = async (m, u, b) => { const r = await fetch(B + u, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 300)}`); return JSON.parse(t); };
const p = await j("POST", "/projects", { title: "Lighter NEMA 17 bracket (autopilot)", intendedDecision: "A bracket lighter than the 48.4 g reference that passes every B-Rep check",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
const st = await j("GET", "/state");
const light = await j("POST", `/projects/${p.id}/cad`, { requestId: crypto.randomUUID(), projectRevision: 1, variant: "lightweight", requirements: { ...st.capabilities.cad.defaultRequirements, maxMassG: 50, minWallMm: 3.2 } });
console.log("start", light.verdict, light.candidate.checks.filter(c => !c.passed).map(c => `${c.id}=${c.observed}`));
const grant = await j("POST", `/projects/${p.id}/autonomy-grants`, { tools: ["cad-review", "cad-code"], maxRuns: 3, hours: 2, note: "autopilot e2e" });
const t0 = Date.now();
let a = await j("POST", `/projects/${p.id}/autopilot`, { requestId: crypto.randomUUID(), grantId: grant.id, maxRounds: 3,
  goal: "Make the NEMA 17 bracket pass every frozen check (min wall 3.2 mm, mass at most 50 g and lighter than 45 g as a design target, interface, hole edge distance) without relaxing anything. The 2.5 mm lightweight variant fails min wall; the 4 mm reference is 48.4 g. Write CadQuery code (cad-code) for a bracket that meets both." });
console.log(JSON.stringify({ id: a.id, state: a.state, outcome: a.outcome, minutes: +((Date.now() - t0) / 60000).toFixed(1), error: a.error,
  rounds: a.rounds.map(r => ({ round: r.round, tool: r.tool, verdict: r.verdict, failing: r.failing?.map(f => `${f.id}=${f.observed}`), note: r.note })) }, null, 1));
const g = (await j("GET", `/autonomy-grants?projectId=${p.id}`))[0];
console.log("grant runs", g.runs.length, "/", g.maxRuns, g.runs.map(r => r.by));
