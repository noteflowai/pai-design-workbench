/** Fast read-only UI checks against completed native artifacts; never launches a new scene. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { Project } from "../src/contracts.js";
import type { SceneReview } from "../src/scenes.js";
const config = { ...configuration(), state: resolve(process.argv[2] ?? ".state/browser"), port: 4320 };
const { app } = await createApp(config);
await app.listen({ port: config.port, host: "127.0.0.1" });
const browser = await chromium.launch(process.env.PAI_BROWSER ? { executablePath: process.env.PAI_BROWSER } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${config.port}`);
  const state = await (await page.request.get(`http://127.0.0.1:${config.port}/api/state`)).json() as { projects: Project[]; scenes: SceneReview[] };
  const project = state.projects.at(-1); assert.ok(project);
  const rejected = state.scenes.find(s => s.projectId === project.id && s.verdict === "rejected");
  const accepted = state.scenes.find(s => s.projectId === project.id && s.verdict === "accepted-static-scene");
  assert.ok(rejected && accepted, "Completed native browser fixtures required");
  await page.getByRole("combobox", { name: "选择场景检查记录" }).selectOption(accepted.id);
  assert.equal(await page.getByRole("heading", { name: "静态场景检查通过" }).count(), 1);
  await page.getByRole("combobox", { name: "选择场景检查记录" }).selectOption(rejected.id);
  await page.getByRole("heading", { name: "场景检查拒绝" }).waitFor();
  await page.locator(".scene-previews img").first().evaluate(async element => { await (element as HTMLImageElement).decode(); });
  await page.locator(".scene-previews img").last().evaluate(async element => { await (element as HTMLImageElement).decode(); });
  assert.equal(await page.locator(".scene-previews img").count(), 2);
  await mkdir("docs/evidence", { recursive: true });
  await page.locator("#industrial").screenshot({ path: "docs/evidence/blender-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#industrial").screenshot({ path: "docs/evidence/blender-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", existingNativeSceneSelection: true, newNativeCommands: 0, mobileWidth: 390, javascriptErrors: errors.length }));
} finally { await browser.close(); await app.close(); }
