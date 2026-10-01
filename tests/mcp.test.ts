import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Adapters } from "../src/adapters.js";
import type { AssistantPlan } from "../src/assistant.js";
import { DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import { workbenchUrl } from "../src/mcp.js";

const task = { title: "Bracket", intendedDecision: "Lighten the bracket without losing wall or interface",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };
const ids = ["solid-valid", "nema17-interface", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope"];
const checks = (failing: string[]) => ({ schema: "pai-cad-checks-1", variant: "lightweight", cadquery: "2.8.0", ocp: "7.9.3.1.1", units: "mm", mass: 31.85, volume: 1,
  boundingBox: [60, 30, 48.5], checks: ids.map(id => ({ id, passed: !failing.includes(id), observed: id === "min-wall" ? 2.5 : 1, required: id === "min-wall" ? 3 : 1 })),
  scope: "parametric-part-geometry", physicalValidation: false });
const freePort = () => new Promise<number>(resolve => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "pai-mcp-"));
  const port = await freePort();
  const config = { ...configuration(), state: dir, port, controllerEntrypoint: undefined, controllerDatabase: undefined };
  const { app, store, workbench } = await createApp(config, {} as Adapters);
  await app.listen({ host: "127.0.0.1", port });
  const project = workbench.createProject(task);
  const cad = { id: randomUUID(), projectId: project.id, projectRevision: 1, request: { requestId: randomUUID(), projectRevision: 1, variant: "lightweight", requirements: DEFAULT_CAD_REQUIREMENTS },
    requirementDigest: "x", state: "completed", createdAt: new Date().toISOString(), verdict: "rejected",
    baseline: checks([]), candidate: checks(["min-wall"]), receipts: [], sourceDigests: {}, files: {}, scope: "parametric-part-geometry", physicalValidation: false } as unknown as CadReview;
  store.insert("cad-review", cad);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"],
    env: { PATH: process.env.PATH ?? "", PAI_URL: `http://127.0.0.1:${port}` }, stderr: "pipe" });
  const client = new Client({ name: "pai-test-agent", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { error: Boolean(r.isError), text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
  return { store, project, cad, client, call,
    cleanup: async () => { await client.close(); await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("MCP exposes reads and proposals only; read tools are annotated read-only", async () => {
  const s = await setup();
  try {
    const { tools } = await s.client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, ["pai_get_admission", "pai_get_plan", "pai_get_record", "pai_get_workspace", "pai_list_projects", "pai_list_versions", "pai_propose_plan"]);
    assert.ok(!names.some(n => /approve|release|confirm|execute|feedback|reconcil|run_/.test(n)), "no authority-bearing tool");
    for (const t of tools.filter(t => t.name !== "pai_propose_plan")) assert.equal(t.annotations?.readOnlyHint, true, t.name);
    const propose = tools.find(t => t.name === "pai_propose_plan")!;
    assert.equal(propose.annotations?.destructiveHint, false);

    const projects = (await s.call("pai_list_projects")).json();
    assert.equal(projects[0].id, s.project.id);
    const ws = (await s.call("pai_get_workspace", { projectId: s.project.id })).json();
    assert.equal(ws.handles["cad-1"].id, s.cad.id);
    assert.ok(ws.tools["cad-review"].payload.properties.variant, "tool schemas are the same JSON schemas the in-app engine sees");
    assert.ok(!("create-project" in ws.tools) && !("approve-release" in ws.tools));
    const record = (await s.call("pai_get_record", { projectId: s.project.id, handle: "cad-1" })).json();
    assert.equal(record.record.candidate.checks.find((c: { id: string }) => c.id === "min-wall").observed, 2.5);
    const admission = (await s.call("pai_get_admission", { projectId: s.project.id, handle: "cad-1" })).json();
    assert.equal(admission.admissible, false);
    const missing = await s.call("pai_get_record", { projectId: s.project.id, handle: "cad-9" });
    assert.ok(missing.error && /NOT_FOUND/.test(missing.text));
  } finally { await s.cleanup(); }
});

test("MCP proposals pass the same contracts: relax diff, rejected tools, invalid citations; no authority and no execution", async () => {
  const s = await setup();
  try {
    const before = s.store.list("cad-review").length;
    const r = await s.call("pai_propose_plan", { projectId: s.project.id, intent: "壁厚保持 3 mm 复测紧凑化方案；试一下放宽壁厚",
      answer: { text: "cad-1 因最小壁厚 2.5 mm < 3 mm 被拒绝。", citations: ["cad-1"] },
      plans: [
        { ref: "p1", tool: "cad-review", title: "紧凑化复测", payload: { variant: "compact" } },
        { ref: "p2", tool: "cad-review", rationale: "验证减重上限", payload: { variant: "lightweight", requirements: { minWallMm: 2.5 } } },
        { ref: "p3", tool: "approve-release", payload: {} },
        { ref: "p4", tool: "cad-review", payload: { variant: "lightweight", requirements: { minWallMm: "thin" } } },
      ] });
    assert.equal(r.error, false, r.text);
    const out = r.json();
    assert.equal(out.authority, "none");
    assert.deepEqual(out.accepted.map((p: { id: string }) => p.id), ["p1", "p2"]);
    const relaxed = out.accepted[1].changes.find((c: { field: string }) => c.field === "minWallMm");
    assert.deepEqual([relaxed.from, relaxed.to, relaxed.direction], [3, 2.5, "relaxed"]);
    assert.ok(out.accepted[1].warnings.some((w: string) => w.includes("放宽")));
    assert.equal(out.rejected.length, 2);
    assert.match(out.rejected[0], /已拒绝外部计划 p3（approve-release）/);
    assert.match(out.rejected[1], /参数不符合 schema/);
    assert.deepEqual(out.citations, ["cad-1"]);

    const stored = s.store.get<AssistantPlan>("assistant-plan", out.planId)!;
    assert.equal(stored.source, "external"); assert.equal(stored.external!.agent, "pai-test-agent");
    assert.equal(stored.model.used, false); assert.equal(stored.confirmations.length, 0);
    assert.equal(s.store.list("cad-review").length, before, "proposing never runs a native tool");
    const status = (await s.call("pai_get_plan", { planId: out.planId })).json();
    assert.deepEqual(status.steps.map((x: { confirmed: unknown }) => x.confirmed), [null, null]);

    const forged = await s.call("pai_propose_plan", { projectId: s.project.id, intent: "x",
      answer: { text: "见 cad-7", citations: ["cad-7"] }, plans: [{ ref: "p1", tool: "cad-review", payload: { variant: "compact" } }] });
    assert.ok(forged.error && /INVALID_CITATION/.test(forged.text) && /cad-7/.test(forged.text));
    const none = await s.call("pai_propose_plan", { projectId: s.project.id, intent: "发布", plans: [{ ref: "p1", tool: "approve-release", payload: {} }] });
    assert.ok(none.error && /NO_VALID_PLAN/.test(none.text));

    // Same request identity: idempotent, no second plan record.
    const requestId = randomUUID();
    const args = { projectId: s.project.id, intent: "复测", requestId, plans: [{ ref: "p1", tool: "cad-review", payload: { variant: "reference" } }] };
    const a = (await s.call("pai_propose_plan", args)).json(), b = (await s.call("pai_propose_plan", args)).json();
    assert.equal(a.planId, b.planId);
  } finally { await s.cleanup(); }
});

test("MCP server only talks to a loopback workbench", () => {
  assert.equal(workbenchUrl("http://127.0.0.1:4317").origin, "http://127.0.0.1:4317");
  assert.equal(workbenchUrl("http://localhost:4400").port, "4400");
  for (const bad of ["https://pai.oneai.host", "http://10.0.0.5:4317", "http://127.0.0.1.evil.example:4317", "http://user@127.0.0.1:4317", "http://127.0.0.1:4317/api", "file:///etc/passwd"]) {
    assert.throws(() => workbenchUrl(bad), /loopback/, bad);
  }
});
