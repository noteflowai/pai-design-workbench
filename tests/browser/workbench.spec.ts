import { test, expect } from "@playwright/test";
test("authenticated workspace keeps sign-out visible at phone width", async ({ page }) => {
  // Layout-only fixture. No native outputs, observed users or commands are fabricated.
  await page.route("**/api/state", route => route.fulfill({ json: {
    projects: [], reviews: [], feedback: [], campaigns: [], proposals: [], scenes: [],
    metrics: { independentParticipants: 0, independentEvents: 0, independentRepeatUsers: 0, maintainerEvents: 0, fixtureEvents: 0 },
    capabilities: { modelProposal: false, blender: false, authenticatedWorkspace: true },
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "退出登录" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("real native review, video decoding, rollback feedback, handoff and mobile layout", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/");
  await page.getByRole("button", { name: /创建.*任务/ }).click();
  await expect(page.getByText("任务和验收要求已冻结为版本 1。")).toBeVisible();
  await page.getByRole("button", { name: "验证 相机偏移 ↗" }).click();
  await expect(page.getByRole("heading", { name: "拒绝采用", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("video")).toHaveCount(2);
  await expect.poll(() => page.locator("video").evaluateAll(videos =>
    videos.every(v => (v as HTMLVideoElement).videoWidth > 0 && (v as HTMLVideoElement).duration > 0))).toBe(true);
  await page.locator("video").first().evaluate(async v => { const video = v as HTMLVideoElement; video.muted = true; await video.play(); });
  await expect.poll(() => page.locator("video").first().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await page.locator("video").first().evaluate(v => (v as HTMLVideoElement).pause());
  await page.getByRole("button", { name: "记录案例反馈" }).click();
  for (const name of ["记录复现", "分配处理", "提出回退方案", "回退基准并复测", "关闭已复测反馈"]) {
    await page.getByRole("button", { name, exact: true }).last().click();
    await expect(page.locator(".busy")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("status")).toBeVisible();
  }
  await expect(page.getByText("已关闭", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "生成试用案例草稿" }).click();
  await expect(page.getByText("试用邀请草稿已生成，尚未发送。")).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.metrics.independentParticipants).toBe(0);
  const run = state.reviews.find((r: { candidate: string; projectId: string }) => r.candidate === "camera" && r.projectId === state.projects.at(-1).id);
  const packet = await (await page.request.get(`/api/runs/${run.id}/bundle`)).json();
  const checked = await page.request.post("/api/bundles/verify", { data: packet });
  expect(checked.status()).toBe(200); expect((await checked.json()).valid).toBe(true);
  const range = await page.request.get(`/api/runs/${run.id}/media/camera/9/main`, { headers: { Range: "bytes=0-99" } });
  expect(range.status()).toBe(206); expect((await range.body()).length).toBe(100);
  await page.getByRole("combobox", { name: "选择检查记录" }).selectOption(run.id);
  await page.locator("#validation").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByRole("heading", { name: "让设计决策有证据。" })).toBeVisible();
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
    (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat());
  expect(cached.some(path => path.startsWith("/api/"))).toBe(false);
});
test("native Blender artifacts, rendering and scene feedback in browser", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: /创建.*任务/ }).click();
  await expect(page.getByText("任务和验收要求已冻结为版本 1。")).toBeVisible();
  await page.getByRole("button", { name: "生成并检查 Blender 场景" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 150_000 });
  await expect.poll(() => page.locator(".scene-previews img").evaluateAll(images => images.length === 2 && images.every(i => (i as HTMLImageElement).naturalWidth === 640))).toBe(true);
  await page.getByRole("button", { name: "记录遮挡反馈" }).click();
  for (const name of ["记录复现", "分配处理", "提出回退方案", "回退基准并复测", "关闭已复测反馈"]) {
    await page.getByRole("button", { name, exact: true }).last().click();
    await expect(page.locator(".busy")).toHaveCount(0, { timeout: 150_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await expect(page.getByRole("heading", { name: "静态场景检查通过" })).toBeVisible();
  await expect(page.getByText("已关闭", { exact: true }).first()).toBeVisible();
  const latest = await (await page.request.get("/api/state")).json();
  const rejected = latest.scenes.find((s: { projectId: string; verdict: string }) => s.projectId === latest.projects.at(-1).id && s.verdict === "rejected");
  await page.getByRole("combobox", { name: "选择场景检查记录" }).selectOption(rejected.id);
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible();
  await page.locator("#industrial").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("blender-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("blender-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
