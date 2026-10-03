import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMcpServer } from "../src/mcp.js";

/** Drift guard between the MCP server and the AgentForge profile that governs it. */
const profile = JSON.parse(readFileSync("integrations/agentforge/mcp-profile.json", "utf8"))["pai-workbench"];
const glob = (pattern: string, key: string) => new RegExp(`^${pattern.split("*").map(s => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`).test(key);

test("every pai-mcp tool is explicitly allowed by the AgentForge profile; nothing else is", () => {
  const server = createMcpServer(async () => ({}));
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  const allowed = (profile.policy.allow as string[]).map(a => a.replace(/^pai\//, "")).sort();
  assert.deepEqual(allowed, tools, "profile allow list must equal the server's tool set");
  for (const tool of tools) assert.ok(!(profile.policy.deny as string[]).some(d => glob(d, `pai/${tool}`)), `${tool} is denied by the profile`);
  assert.equal(profile.policy.defaultAllow, false);
  assert.equal(profile.policy.denyHighRisk, true);
  assert.equal(profile.gateway, true);
});

test("the profile uses only fields the AgentForge Host accepts and carries no credential", () => {
  assert.deepEqual(Object.keys(profile).sort(), ["gateway", "mcpServers", "policy"]);
  const [server] = profile.mcpServers;
  assert.equal(server.name, "pai"); assert.ok(Array.isArray(server.args));
  for (const key of Object.keys(server.env)) assert.ok(!/SECRET$|TOKEN$|PASSWORD|KEY$/.test(key) || key.endsWith("_FILE"), key);
});

test("the Agent Skill is a valid SKILL.md with name and version frontmatter", () => {
  const md = readFileSync("integrations/agentforge/skills/pai-industrial-design/SKILL.md", "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  assert.match(fm, /^name: pai-industrial-design$/m);
  assert.match(fm, /^version: "\d+\.\d+\.\d+"$/m);
  assert.match(fm, /^description: /m);
});
