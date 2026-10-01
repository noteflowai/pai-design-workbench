import { test, expect, type Page } from "@playwright/test";

const rail = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "生命周期" }).getByRole("link", { name });
async function createProject(page: Page) {
  await page.goto("/#/requirements?new=1");
  await page.getByRole("button", { name: "创建评审任务" }).click();
  await expect(page.getByText("任务和验收要求已冻结为版本 1。")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("SmolVLA 相机布局设计评审");
}
async function advance(page: Page, names: string[], timeout = 60_000) {
  for (const name of names) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".busy")).toHaveCount(0, { timeout });
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
}
const noOverflow = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test("authenticated workspace keeps sign-out and lifecycle navigation usable at phone width", async ({ page }) => {
  // Layout-only fixture. No native outputs, observed users or commands are fabricated.
  await page.route("**/api/state", route => route.fulfill({ json: {
    projects: [], reviews: [], feedback: [], campaigns: [], proposals: [], scenes: [],
    metrics: { independentParticipants: 0, independentEvents: 0, independentRepeatUsers: 0, maintainerEvents: 0, fixtureEvents: 0 },
    capabilities: { modelProposal: false, blender: false, authenticatedWorkspace: true },
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "退出登录" })).toBeVisible();
  await expect(page.getByText("还没有评审任务")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "AI 助手" })).toHaveCount(0);
  await noOverflow(page);
});

test("full lifecycle: requirement, native review, replay, feedback recheck, handoff and revision", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await expect(page.getByRole("region", { name: "下一步" })).toContainText("提交第一个候选进行原生验证");
  await rail(page, /候选设计/).click();
  await page.getByRole("button", { name: "提交验证：相机偏移" }).click();
  await expect(page.getByRole("heading", { name: "拒绝采用", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("EvalArc 检测到丢失 1 个基准成功样本")).toBeVisible();
  await expect(rail(page, /失败回放/)).toHaveClass(/s-attention/);
  await page.getByRole("button", { name: "回放", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "配对种子" })).toHaveValue("9");
  await expect(page.locator("video")).toHaveCount(2);
  await expect.poll(() => page.locator("video").evaluateAll(videos =>
    videos.every(v => (v as HTMLVideoElement).videoWidth > 0 && (v as HTMLVideoElement).duration > 0))).toBe(true);
  await page.locator("video").first().evaluate(async v => { const video = v as HTMLVideoElement; video.muted = true; await video.play(); });
  await expect.poll(() => page.locator("video").first().evaluate(v => (v as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await page.locator("video").first().evaluate(v => (v as HTMLVideoElement).pause());
  await page.getByRole("button", { name: /记录反馈：seed 9/ }).click();
  await expect(page.getByRole("heading", { name: "反馈复测", level: 1 })).toBeVisible();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "回退基准并复测", "关闭已复测反馈"]);
  await page.getByRole("button", { name: /已关闭 1/ }).click();
  await expect(page.locator(".run-list").getByText("已关闭", { exact: true })).toBeVisible();
  await rail(page, /项目总览/).click();
  await expect(page.getByRole("region", { name: "下一步" })).toContainText("创建发布候选");
  await page.getByRole("region", { name: "下一步" }).getByRole("button", { name: "前往 →" }).click();
  // The release cites the passing rollback recheck; the rejected camera review stays a retained failure.
  await page.getByRole("button", { name: "创建发布候选" }).click();
  await page.getByRole("button", { name: "批准发布 R1" }).click();
  await expect(page.getByRole("button", { name: /成熟度：R1 已发布/ })).toBeVisible();
  await page.getByRole("button", { name: "生成案例草稿" }).click();
  await expect(page.getByText("案例草稿已生成，尚未发送。")).toBeVisible();
  await expect(page.locator("details pre")).toContainText("Not sent or published by this workbench");
  const state = await (await page.request.get("/api/state")).json();
  expect(state.metrics.independentParticipants).toBe(0);
  const projectId = state.projects.at(-1).id;
  expect(state.lifecycles[projectId].stages.map((s: { status: string }) => s.status)).toEqual(["done", "done", "done", "done", "done", "done"]);
  const run = state.reviews.find((r: { candidate: string; projectId: string }) => r.candidate === "camera" && r.projectId === projectId);
  const packet = await (await page.request.get(`/api/runs/${run.id}/bundle`)).json();
  const checked = await page.request.post("/api/bundles/verify", { data: packet });
  expect(checked.status()).toBe(200); expect((await checked.json()).valid).toBe(true);
  const range = await page.request.get(`/api/runs/${run.id}/media/camera/9/main`, { headers: { Range: "bytes=0-99" } });
  expect(range.status()).toBe(206); expect((await range.body()).length).toBe(100);
  await rail(page, /项目总览/).click();
  await page.screenshot({ path: testInfo.outputPath("overview-desktop.png"), fullPage: true });
  await rail(page, /需求冻结/).click();
  await page.getByRole("button", { name: "修订需求" }).click();
  await page.getByRole("combobox", { name: "样本最低成功率" }).selectOption("0.7");
  await page.getByRole("button", { name: "保存为 v2" }).click();
  await expect(page.getByText(/需求已修订为 v2/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "选择已有任务" })).toContainText("v2");
  for (const width of [1024, 1280, 1440]) {
    // The docked assistant must sit beside the work area, never on top of it.
    await page.setViewportSize({ width, height: 800 });
    if (await page.getByRole("complementary", { name: "AI 助手" }).count() === 0) await page.getByRole("button", { name: "AI 助手" }).click();
    const [mainBox, asideBox] = await Promise.all([page.locator("main").boundingBox(), page.getByRole("complementary", { name: "AI 助手" }).boundingBox()]);
    expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(asideBox!.x + 1);
    expect(mainBox!.width).toBeGreaterThanOrEqual(560);
    await noOverflow(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("complementary", { name: "AI 助手" })).toHaveCount(0);
  await rail(page, /原生验证/).click();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("validate-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect(page.getByRole("navigation", { name: "生命周期" })).toBeVisible();
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key =>
    (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat());
  expect(cached.some(path => path.startsWith("/api/"))).toBe(false);
});

test("native Blender scene from the professional form: rejection, evidence files and occlusion recheck", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "Blender 场景" }).click();
  await page.getByRole("button", { name: "生成并检查 Blender 场景" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 150_000 });
  await expect.poll(() => page.locator(".scene-previews img").evaluateAll(images => images.length === 2 && images.every(i => (i as HTMLImageElement).naturalWidth === 640))).toBe(true);
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  await expect(page.getByRole("link", { name: "下载可编辑 .blend" })).toBeVisible();
  await expect(page.locator(".data-table tbody tr")).toHaveCount(7);
  await page.getByRole("button", { name: /记录反馈：Blender 相机可见性/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "移除遮挡并复测", "关闭已复测反馈"], 150_000);
  const latest = await (await page.request.get("/api/state")).json();
  const mine = latest.scenes.filter((s: { projectId: string }) => s.projectId === latest.projects.at(-1).id);
  expect(mine.map((s: { verdict: string }) => s.verdict).sort()).toEqual(["accepted-static-scene", "rejected"]);
  expect(latest.feedback.at(-1).status).toBe("closed");
  await rail(page, /原生验证/).click();
  await page.getByRole("button", { name: /Blender 场景 带遮挡候选布局 场景检查拒绝/ }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("blender-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("blender-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("AI assistant plan runs native Blender live in the professional viewport", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await expect(assistant).toBeVisible();
  await assistant.getByRole("button", { name: "规则", exact: true }).click();
  await assistant.locator("#studio-input").fill("生成带遮挡的 Blender 工作单元，占地不超过 12 平方米，包络半径 1.4 m");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  const card = assistant.getByRole("article", { name: /计划 Blender 原生场景/ });
  await expect(assistant.getByText("规则解析 · 无模型调用").first()).toBeVisible();
  await expect(card.getByText("— → occluded")).toBeVisible();
  await card.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("heading", { name: "原生验证", level: 1 })).toBeVisible();
  const viewport = page.locator(".viewport");
  // Geometry must appear while the native run is still live, not only after completion.
  await expect.poll(async () => (await viewport.getAttribute("data-objects")) !== "0" && await page.locator(".viewport .live-dot.on").count() === 1,
    { timeout: 120_000 }).toBe(true);
  await expect(page.getByLabel("实时工具步骤").first().getByText("Blender 基准场景（无遮挡）")).toBeVisible();
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 200_000 });
  await expect(viewport).toHaveAttribute("data-webgl", "ok");
  await expect(viewport).toHaveAttribute("data-ray", "blocked");
  await expect(viewport).toHaveAttribute("data-objects", "7");
  await expect(page.getByText("原生射线首个命中：Visibility obstruction · 被遮挡")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Cycles 渲染采样" })).toHaveAttribute("aria-valuenow", "12");
  await page.getByRole("button", { name: "顶视" }).click();
  await page.getByRole("slider", { name: "构建阶段时间轴" }).fill("0");
  await expect(viewport).toHaveAttribute("data-stage", "1");
  await expect.poll(() => viewport.getAttribute("data-objects")).toBe("1");
  await page.getByRole("button", { name: "基准布局" }).click();
  await expect(viewport).toHaveAttribute("data-ray", "target");
  const latest = await (await page.request.get("/api/state")).json();
  const plan = latest.assistantPlans.at(-1);
  expect(plan.authority).toBe("none"); expect(plan.model.used).toBe(false);
  expect(plan.confirmations.find((c: { recordKind: string }) => c.recordKind === "scene-review").match).toBe("as-proposed");
  await page.screenshot({ path: testInfo.outputPath("studio-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("studio-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("factory criteria are frozen first; real Factory Twin seeds stay failed through feedback", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await assistant.getByRole("button", { name: "规则", exact: true }).click();
  await assistant.locator("#studio-input").fill("评审工厂维护与能源方案：产出不能下降，EV 充电不低于 80%，车间不超过 25 °C");
  await page.keyboard.press("Control+Enter");
  const review = assistant.getByRole("article", { name: /计划 导入已复核/ });
  await review.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("alert")).toContainText("请先确认前置计划");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.getByRole("article", { name: "计划 先冻结工厂验收标准" }).getByRole("button", { name: "确认执行" }).click();
  await expect(assistant.getByRole("article", { name: "计划 先冻结工厂验收标准" }).getByText(/已执行/)).toBeVisible();
  await review.getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("heading", { name: "维护方案拒绝" })).toBeVisible();
  await expect(page.locator(".seed-table tbody tr")).toHaveCount(12);
  await expect(page.locator(".seed-table td.fail")).toHaveCount(3);
  await expect(page.locator(".cases li")).toHaveCount(3);
  await page.getByRole("button", { name: /记录反馈：工厂 seed 10/ }).click();
  await advance(page, ["记录复现", "分配处理", "记录保留原因", "复测保留方案", "关闭已复测反馈"], 30_000);
  await page.getByRole("button", { name: /全部/ }).click();
  await expect(page.locator(".run-list").getByText(/工厂 · seed 10 · EV 充电服务/)).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  const f = state.feedback.find((x: { evidenceKind: string }) => x.evidenceKind === "factory-twin");
  expect(f.status).toBe("closed");
  expect(state.factoryReviews.every((r: { verdict: string; physicalValidation: boolean }) => r.verdict === "rejected" && r.physicalValidation === false)).toBe(true);
  await rail(page, /需求冻结/).click();
  await expect(page.locator("#factory-criteria tbody tr")).toHaveCount(1);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.keyboard.type("工厂");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "工厂孪生" })).toHaveAttribute("aria-selected", "true");
  await rail(page, /原生验证/).click();
  await page.getByRole("button", { name: /工厂孪生 .* 维护方案拒绝/ }).first().click();
  await page.screenshot({ path: testInfo.outputPath("factory-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("factory-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("parametric CAD part: live B-Rep build, measured DFM failure, drawings and restored-parameter recheck", async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad) throw new Error("Native CadQuery is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  // Choose a non-default option first so a dead hit target cannot pass silently.
  await page.getByRole("radio", { name: /紧凑化/ }).check();
  await expect(page.getByRole("radio", { name: /紧凑化/ })).toBeChecked();
  await page.locator(".option", { hasText: "止口孔偏小" }).click();
  await expect(page.getByRole("radio", { name: /止口孔偏小/ })).toBeChecked();
  await page.getByRole("radio", { name: /轻量化/ }).check();
  await expect(page.getByRole("radio", { name: /轻量化/ })).toBeChecked();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  const viewport = page.locator(".viewport");
  await expect.poll(async () => (await viewport.getAttribute("data-objects")) !== "0" && await page.locator(".viewport .live-dot.on").count() === 1,
    { timeout: 120_000 }).toBe(true);
  await expect(page.getByText("LIVE · CadQuery 原生构建中")).toBeVisible();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  await expect(viewport).toHaveAttribute("data-objects", "2");
  await expect(page.locator(".outliner").getByText("NEMA 17 motor")).toBeVisible();
  await expect(page.locator(".check-item.fail")).toHaveCount(1);
  await expect(page.locator(".check-item.fail")).toContainText("最小壁厚");
  // ~85 kB SVG drawings decode after the native run; allow for a loaded CI runner.
  await expect.poll(() => page.locator(".drawings img").evaluateAll(images => images.length === 2 && images.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)),
    { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  const step = await page.request.get(await page.getByRole("link", { name: "下载可编辑 STEP" }).getAttribute("href") as string);
  expect(step.status()).toBe(200); expect((await step.text()).startsWith("ISO-10303-21")).toBe(true);
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "恢复基准参数并复测", "关闭已复测反馈"], 180_000);
  const latest = await (await page.request.get("/api/state")).json();
  const mine = latest.cads.filter((c: { projectId: string }) => c.projectId === latest.projects.at(-1).id);
  expect(mine.map((c: { verdict: string }) => c.verdict).sort()).toEqual(["accepted-cad-part", "rejected"]);
  expect(latest.feedback.at(-1).status).toBe("closed");
  await rail(page, /原生验证/).click();
  await page.getByRole("button", { name: /CAD 零件 NEMA 17 支架 · 轻量化 零件检查拒绝/ }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cad-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("cad-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("release gate: blocked until failures are closed, approval, compare matrix and supersession by a new requirement version", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad) throw new Error("Native CadQuery is required for this integration check");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await rail(page, /发布交付/).click();
  await expect(page.getByText("还没有可发布的检查")).toBeVisible();
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  await rail(page, /反馈复测/).click();
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "恢复基准参数并复测"], 180_000);
  // Passing recheck exists but its feedback is still open: admission must block the release.
  await rail(page, /发布交付/).click();
  const gate = page.getByLabel("发布准入检查");
  await expect(gate.locator(".check-item.fail")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "创建发布候选" })).toBeDisabled();
  await gate.getByRole("button", { name: "处理反馈" }).click();
  await advance(page, ["关闭已复测反馈"]);
  await rail(page, /发布交付/).click();
  await expect(gate.locator(".check-item.fail")).toHaveCount(0);
  await expect(gate.locator(".check-item.pass")).toHaveCount(5);
  await page.getByRole("button", { name: "创建发布候选" }).click();
  await expect(page.getByRole("button", { name: "批准发布 R1" })).toBeVisible();
  await expect(page.getByRole("button", { name: /成熟度：R1 待审批/ })).toBeVisible();
  await page.getByRole("button", { name: "批准发布 R1" }).click();
  await expect(page.getByRole("button", { name: /成熟度：R1 已发布/ })).toBeVisible();
  await expect(rail(page, /发布交付/)).toHaveClass(/s-done/);
  await expect(page.locator(".release-history tbody tr")).toHaveCount(1);
  await rail(page, /原生验证/).click();
  const compare = page.locator("#compare");
  await expect(compare.locator("thead th")).toHaveCount(3);
  await expect(compare.locator("td.fail")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("release-compare.png"), fullPage: true });
  await rail(page, /需求冻结/).click();
  await page.getByRole("button", { name: "修订需求" }).click();
  await page.getByRole("combobox", { name: "样本最低成功率" }).selectOption("0.7");
  await page.getByRole("button", { name: "保存为 v2" }).click();
  await expect(page.locator(".versions li")).toHaveCount(2);
  await expect(page.locator(".diff td.del")).toHaveText("50%");
  await expect(page.locator(".diff td.add")).toHaveText("70%");
  await expect(page.getByRole("button", { name: /成熟度：设计中/ })).toBeVisible();
  await rail(page, /发布交付/).click();
  await expect(page.locator(".release-history").getByText("已废止")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("release-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await expect(page.getByRole("contentinfo", { name: "状态栏" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("release-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("AI engine: Kiro fallback receipt, cited answer, validated plan, reconciliation gate", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { writeFile } = await import("node:fs/promises");
  const spec = (o: unknown) => writeFile(".state/browser/fake-executor.json", JSON.stringify(o));
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  // The two intended 409 rejections surface as toasts; Chrome also logs them as resource errors.
  page.on("console", m => { if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await assistant.getByRole("button", { name: "AI 引擎", exact: true }).click();
  const out = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";
  await spec({ attempts: [{ profile: "kiro-primary", status: "failed", errorKind: "quota" }, { profile: "kiro-backup", status: "succeeded", answer: out({
    kind: "plan", interpretation: ["保持壁厚 3 mm，复测紧凑化方案"], answer: { text: "cad-1 因最小壁厚 2.5 mm < 3 mm 被拒绝。", citations: ["cad-1"] },
    plans: [{ ref: "p1", tool: "cad-review", title: "复测紧凑化方案", payload: { variant: "compact" } }, { ref: "p2", tool: "approve-release", payload: {} }] }) }] });
  await assistant.locator("#studio-input").fill("为什么轻量化被拒绝？给出复测方案");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  const fallback = assistant.getByRole("list", { name: "引擎回退链" }).last();
  await expect(fallback).toContainText("Kiro 主账号 · 额度不足");
  await expect(fallback).toContainText("Kiro 备用账号 ✓");
  await expect(assistant.getByText("Kiro 备用账号 · claude-opus-5.5").last()).toBeVisible();
  await expect(assistant.getByText(/已拒绝 AI 计划 p2（approve-release）/)).toBeVisible();
  // Answer bubbles, citations and plan cards stack in normal flow; none overlaps another.
  const overlaps = await assistant.locator(".chat-timeline").evaluate(el => {
    el.scrollTop = el.scrollHeight;
    if ([...el.querySelectorAll("*")].some(n => ["sticky", "fixed"].includes(getComputedStyle(n).position))) return true;
    const boxes = [...el.querySelectorAll(".turn > *")].map(n => n.getBoundingClientRect()).filter(r => r.height > 0);
    return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.bottom - 1 > b.top && b.bottom - 1 > a.top));
  });
  expect(overlaps).toBe(false);
  const cite = assistant.getByRole("group", { name: "引用的记录" }).last().getByRole("button", { name: /CAD 零件 · lightweight/ });
  await cite.click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible();
  const card = assistant.getByRole("article", { name: "计划 复测紧凑化方案" });
  await expect(card.getByText("— → compact").or(card.getByText("lightweight → compact"))).toBeVisible();
  await card.getByRole("button", { name: "确认执行" }).click();
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 180_000 });
  // An answer whose native effects are unverified blocks plans and further AI runs until reconciled.
  await spec({ action: "reconcile", reason: "effects unknown", attempts: [{ profile: "claude", status: "succeeded", effects: "unknown", model: "default", version: "0.84.0",
    answer: out({ kind: "plan", plans: [{ ref: "p1", tool: "robot-review", title: "相机偏移记录评审", payload: { candidate: "camera" } }] }) }] });
  await assistant.locator("#studio-input").fill("再评一次相机偏移");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(assistant.getByRole("group", { name: "核对引擎影响" })).toBeVisible();
  await assistant.getByRole("article", { name: "计划 相机偏移记录评审" }).getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未核对");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.locator("#studio-input").fill("还有别的吗");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未核对");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.getByRole("button", { name: "记录核对结果" }).click();
  await expect(assistant.getByText(/已核对 · local-maintainer/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-desktop.png") });
  const state = await (await page.request.get("/api/state")).json();
  const runs = state.assistantPlans.filter((p: { source?: string }) => p.source === "model");
  expect(runs.map((p: { state: string }) => p.state)).toEqual(["done", "reconcile"]);
  expect(runs.every((p: { authority: string }) => p.authority === "none")).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});
