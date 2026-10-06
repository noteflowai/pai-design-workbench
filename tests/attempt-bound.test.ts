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
