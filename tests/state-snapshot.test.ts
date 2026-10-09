import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";

test("/api/state reads each record kind once and returns the same lifecycles and track records as the per-project routes", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-state-"));
  const config = configuration();
  const { app } = await createApp({ ...config, state });
  const host = `127.0.0.1:${config.port}`;
  try {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = (await app.inject({ method: "POST", url: "/api/projects", headers: { host, "content-type": "application/json" },
        payload: { title: `State ${i % 2}`, intendedDecision: "Single-read state check", requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } } })).json();
      ids.push(p.id);
      const plan = await app.inject({ method: "POST", url: "/api/assistant/plans", headers: { host, "content-type": "application/json" },
        payload: { requestId: randomUUID(), projectId: p.id, message: "工厂能源评审，EV 充电不低于 80%" } });
      assert.equal(plan.statusCode, 200, plan.body);
    }
    // Count how often /api/state parses each kind: once, however many projects there are.
    const reads = new Map<string, number>(), list = Store.prototype.list;
    Store.prototype.list = function <T>(this: Store, kind: string): T[] { reads.set(kind, (reads.get(kind) ?? 0) + 1); return list.call(this, kind) as T[]; };
    let body;
    try { body = (await app.inject({ url: "/api/state", headers: { host } })).json(); } finally { Store.prototype.list = list; }
    for (const [kind, n] of reads) if (kind !== "event") assert.equal(n, 1, `${kind} parsed ${n} times`);
    assert.ok((reads.get("event") ?? 0) <= 2, "events: once for lifecycles, once for metrics");
    assert.equal(body.projects.length, 4);
    for (const id of ids) {
      assert.deepEqual(body.lifecycles[id], (await app.inject({ url: `/api/projects/${id}/lifecycle`, headers: { host } })).json());
      assert.deepEqual(body.aiTrackRecords[id], (await app.inject({ url: `/api/projects/${id}/ai-track-record`, headers: { host } })).json());
    }
    assert.equal(body.assistantPlans.length, 4);
    // The next request sees new records (nothing is cached between requests).
    await app.inject({ method: "POST", url: "/api/projects", headers: { host, "content-type": "application/json" },
      payload: { title: `State ${randomUUID().slice(0, 4)}`, intendedDecision: "Single-read state check", requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } } });
    assert.equal((await app.inject({ url: "/api/state", headers: { host } })).json().projects.length, 5);
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
