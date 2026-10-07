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
  const { PATH: _p, ...bedrock } = engineEnv({ claudeBedrockRegion: "us-east-1" } as never);
  assert.deepEqual(bedrock, { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" });
  const { PATH: _q, ...none } = engineEnv({} as never);
  assert.deepEqual(none, {});
});

test("workbench actors map onto the executor's operator identity", async () => {
  const { operatorIdentity } = await import("../src/controller.js");
  assert.equal(operatorIdentity("maintainer@example.com"), "maintainer@example.com");
  assert.equal(operatorIdentity("local maintainer"), "local-maintainer");
  assert.equal(operatorIdentity("  -x"), "x");
  assert.match(operatorIdentity("a".repeat(200)), /^a{80}$/);
});

test("long planning turns use the extended domain data class only on its contract (three ordered Kiro keys, no images)", async () => {
  const { requestClass } = await import("../src/controller.js");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pai-class-"));
  try {
    await mkdir(join(root, "agent_control")); await mkdir(join(root, "contracts"));
    await writeFile(join(root, "contracts/text-proposal.schema.json"), JSON.stringify({ properties: { timeout_seconds: { maximum: 60 } } }));
    const config = { controlRoot: root, controllerEntrypoint: "x", controllerDatabase: "y" } as never;
    const kiro = ["kiro-primary", "kiro-backup", "kiro-backup2"] as const;
    await writeFile(join(root, "agent_control/executor.py"), "kinds = {'text-proposal'}");
    assert.deepEqual(await requestClass(config, kiro, 0), { kind: "text-proposal", timeoutSeconds: 60 }, "older executor: short class");
    await writeFile(join(root, "agent_control/executor.py"), 'kinds = {"text-proposal", "domain-data-proposal"}');
    assert.deepEqual(await requestClass(config, kiro, 0), { kind: "domain-data-proposal", timeoutSeconds: 180 });
    assert.equal((await requestClass(config, kiro, 1)).kind, "text-proposal", "images keep the short class");
    assert.equal((await requestClass(config, ["kiro-primary", "kiro-backup", "kiro-backup2", "codex"], 0)).kind, "text-proposal");
    assert.equal((await requestClass(config, ["kiro-backup", "kiro-primary", "kiro-backup2"] as never, 0)).kind, "text-proposal");
    assert.equal((await requestClass(config, ["codex"], 0)).kind, "text-proposal");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the executor finds the real Kiro binary first (launch evidence refuses a symlinked native path)", async () => {
  const { executorPath } = await import("../src/controller.js");
  const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pai-path-")));
  try {
    await mkdir(join(root, "real")); await mkdir(join(root, "links"));
    await writeFile(join(root, "real/kiro-cli-chat"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink(join(root, "real/kiro-cli-chat"), join(root, "links/kiro-cli-chat"));
    assert.equal(executorPath(`${root}/links:/usr/bin`), `${root}/real:${root}/links:/usr/bin`);
    assert.equal(executorPath("/usr/bin"), "/usr/bin", "no Kiro: PATH unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});
