// Oracle: scores the workspace's estimate() against held-out CalculiX results (same solver and load as reference.json).
// It lives outside workspace/, so the solver never sees the answers (run through ../run.mjs).
// Pass: median relative error <= 15 %, worst <= 35 %, and the stiffness ranking agrees (Spearman >= 0.9).
import assert from 'node:assert/strict';
// Runs with cwd = the solver's workspace; the held-out results stay outside that workspace.
const { estimate } = await import(new URL('estimate.mjs', 'file://' + process.cwd() + '/').href);
const HELD_OUT = [{"thickness": 2.46, "width": 72.52, "plateHeight": 48.77, "deflectionMm": 0.1905}, {"thickness": 3.8, "width": 57.0, "plateHeight": 45.0, "deflectionMm": 0.0519}, {"thickness": 4.19, "width": 58.2, "plateHeight": 50.83, "deflectionMm": 0.0414}, {"thickness": 4.27, "width": 71.51, "plateHeight": 48.44, "deflectionMm": 0.0464}, {"thickness": 4.27, "width": 73.43, "plateHeight": 47.73, "deflectionMm": 0.0475}, {"thickness": 4.71, "width": 59.37, "plateHeight": 51.11, "deflectionMm": 0.0318}, {"thickness": 5.31, "width": 58.19, "plateHeight": 52.28, "deflectionMm": 0.0239}, {"thickness": 5.48, "width": 71.17, "plateHeight": 59.64, "deflectionMm": 0.0243}, {"thickness": 7.93, "width": 50.71, "plateHeight": 44.74, "deflectionMm": 0.0095}];
const rank = (xs) => { const s = [...xs].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = []; s.forEach(([, i], k) => { r[i] = k; }); return r; };
const errors = HELD_OUT.map((p) => {
  const e = estimate(p);
  assert.ok(Number.isFinite(e) && e > 0, `estimate must be a positive number for ${JSON.stringify(p)}`);
  return { e, err: Math.abs(e - p.deflectionMm) / p.deflectionMm };
});
const rel = errors.map((x) => x.err).sort((a, b) => a - b);
const median = rel[Math.floor(rel.length / 2)], worst = rel.at(-1);
const ra = rank(errors.map((x) => x.e)), rb = rank(HELD_OUT.map((p) => p.deflectionMm)), n = ra.length;
const spearman = 1 - (6 * ra.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0)) / (n * (n * n - 1));
console.log(JSON.stringify({ median: +median.toFixed(3), worst: +worst.toFixed(3), spearman: +spearman.toFixed(3) }));
assert.ok(median <= 0.15, `median relative error ${median.toFixed(3)} > 0.15`);
assert.ok(worst <= 0.35, `worst relative error ${worst.toFixed(3)} > 0.35`);
assert.ok(spearman >= 0.9, `stiffness ranking disagrees (Spearman ${spearman.toFixed(3)})`);
console.log('ok');
