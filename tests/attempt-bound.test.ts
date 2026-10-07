import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attemptBound } from "../src/controller.js";

test("the per-attempt bound comes from the pinned executor's own request contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "pai-bound-"));
  try {
    const config = { controlRoot: root } as Parameters<typeof attemptBound>[0];
    assert.equal(await attemptBound(config), 60, "no contract: the historical 60 s");
    await mkdir(join(root, "contracts"));
    const schema = (max: unknown) => writeFile(join(root, "contracts/text-proposal.schema.json"),
      JSON.stringify({ properties: { timeout_seconds: { type: "integer", minimum: 1, maximum: max } } }));
    await schema(120); assert.equal(await attemptBound(config), 120);
    await schema(60); assert.equal(await attemptBound(config), 60);
    await schema("lots"); assert.equal(await attemptBound(config), 60, "a malformed bound is not trusted");
    await schema(100_000); assert.equal(await attemptBound(config), 60, "an implausible bound is not trusted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Bedrock routing for the Claude engine is scoped to the executor process", async () => {
  const { engineEnv } = await import("../src/controller.js");
  assert.deepEqual(engineEnv({ claudeBedrockRegion: "us-east-1" } as never), { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" });
  assert.deepEqual(engineEnv({} as never), {});
});

test("workbench actors map onto the executor's operator identity", async () => {
  const { operatorIdentity } = await import("../src/controller.js");
  assert.equal(operatorIdentity("maintainer@example.com"), "maintainer@example.com");
  assert.equal(operatorIdentity("local maintainer"), "local-maintainer");
  assert.equal(operatorIdentity("  -x"), "x");
  assert.match(operatorIdentity("a".repeat(200)), /^a{80}$/);
});
