import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { authentication } from "../src/auth.js";

const albAuth = {
  albArn: "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/example/0000000000000000",
  issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/test",
  clientId: "test-client",
};
test("remote claims require a signed ALB token; forged identity headers cannot authorize", async () => {
  const check = authentication({ ...configuration(), albAuth });
  for (const headers of [{}, { "x-amzn-oidc-identity": "owner" },
    { "x-amzn-oidc-data": "forged", "x-amzn-oidc-identity": "owner" },
    { "x-amzn-oidc-data": ["ambiguous"], "x-amzn-oidc-identity": "owner" }]) {
    assert.equal(await check(headers), false);
  }
});
test("cloud health reveals no state; anonymous artifacts, APIs and writes fail closed", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-auth-"));
  const { app } = await createApp({ ...configuration(), state, publicOrigin: "https://pai.oneai.host", albAuth });
  try {
    const host = { host: "pai.oneai.host" };
    const health = await app.inject({ url: "/healthz", headers: host });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok" });
    for (const url of ["/", "/api/state", "/api/tools", "/manifest.webmanifest"]) {
      const response = await app.inject({ url, headers: host });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    const write = await app.inject({ method: "POST", url: "/api/projects",
      headers: { ...host, origin: "https://pai.oneai.host", "x-amzn-oidc-identity": "forged" }, payload: {} });
    assert.equal(write.statusCode, 401);
    assert.equal((await app.inject({ url: "/healthz", headers: { host: "172.31.1.2:4317" } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/state", headers: { host: "attacker.example" } })).statusCode, 403);
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
test("authorized deployment origin retains exact origin checks in local verification mode", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-origin-"));
  const { app } = await createApp({ ...configuration(), state, publicOrigin: "https://pai.oneai.host" });
  try {
    const task = { title: "Deployment origin test", intendedDecision: "Validate allowed origin",
      requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
    const headers = { host: "pai.oneai.host", origin: "https://pai.oneai.host" };
    assert.equal((await app.inject({ method: "POST", url: "/api/projects", headers, payload: task })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/projects",
      headers: { ...headers, origin: "https://pai.oneai.host.attacker.example" }, payload: task })).statusCode, 403);
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
test("logout expires ALB session cookies and follows the configured hosted logout", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-logout-"));
  const authLogoutUrl = "https://example.auth.ap-northeast-1.amazoncognito.com/logout";
  const { app } = await createApp({ ...configuration(), state, authLogoutUrl });
  try {
    const response = await app.inject({ url: "/logout", headers: { host: "localhost:4317" } });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, authLogoutUrl);
    const cookies = response.headers["set-cookie"] as string[];
    assert.equal(cookies.length, 5);
    assert.ok(cookies.every(cookie => cookie.includes("Max-Age=0") && cookie.includes("Secure") && cookie.includes("HttpOnly")));
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
