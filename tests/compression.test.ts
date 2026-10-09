import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";

test("JSON responses are compressed when the client accepts it, identical once decoded; plain otherwise", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-compress-"));
  const config = configuration();
  const { app } = await createApp({ ...config, state });
  try {
    const host = `127.0.0.1:${config.port}`;
    for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: "/api/projects", headers: { host, "content-type": "application/json" },
      payload: { title: `Compression ${i}`, intendedDecision: "Response size check", requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } } });
    const plain = await app.inject({ url: "/api/state", headers: { host } });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.headers["content-encoding"], undefined);
    const expected = plain.json();
    for (const [encoding, decode] of [["br", brotliDecompressSync], ["gzip", gunzipSync]] as const) {
      const r = await app.inject({ url: "/api/state", headers: { host, "accept-encoding": encoding } });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers["content-encoding"], encoding);
      assert.match(String(r.headers.vary), /accept-encoding/i);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(decode(r.rawPayload).toString("utf8")), expected);
      assert.ok(r.rawPayload.length < plain.rawPayload.length / 3, `${encoding} ${r.rawPayload.length} vs ${plain.rawPayload.length}`);
    }
    // Tiny responses stay uncompressed; the health check is unchanged.
    const health = await app.inject({ url: "/healthz", headers: { host, "accept-encoding": "br" } });
    assert.equal(health.headers["content-encoding"], undefined);
    assert.deepEqual(health.json(), { status: "ok" });
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
