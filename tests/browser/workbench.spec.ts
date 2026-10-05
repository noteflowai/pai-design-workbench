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

test("visual review: recorded inspection views go to the AI with the question, pinned by digest", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  expect(state.capabilities.assistant.images).toBe(true);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "Blender 场景" }).click();
  await page.getByRole("button", { name: "生成并检查 Blender 场景" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 150_000 });
  const { writeFile: write, readFile: read, rm } = await import("node:fs/promises");
  const log = ".state/browser/fake-visual.jsonl"; await rm(log, { force: true });
  await write(".state/browser/fake-executor.json", JSON.stringify({ log, attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({
    kind: "plan", interpretation: ["候选相机视图被大块体挡住"], answer: { text: "scene-1 候选视图里一块大面板挡住了工位，射线检查同样失败；改回无遮挡布局。", citations: ["scene-1"] },
    plans: [{ ref: "p1", tool: "scene-review", title: "无遮挡布局复测", payload: { variant: "clear" } }] }) + "\n```" }] }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /带图问 AI（2 张已记录图像）/ }).click();
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  const chips = assistant.getByRole("list", { name: "随问题发送的已记录图像" });
  await expect(chips.getByRole("listitem")).toHaveCount(2);
  await expect(chips).toContainText("候选相机视图");
  await noOverflow(page);
  await assistant.screenshot({ path: testInfo.outputPath("visual-ask-mobile.png") });
  await assistant.getByRole("button", { name: "移除附图 基准相机视图" }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(1);
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(assistant.getByRole("article", { name: "计划 无遮挡布局复测" })).toBeVisible({ timeout: 60_000 });
  await expect(chips).toHaveCount(0);
  // The executor received exactly the recorded candidate preview, by digest; nothing from the browser.
  const sent = JSON.parse((await read(log, "utf8")).trim().split("\n").at(-1)!);
  const after = await (await page.request.get("/api/state")).json();
  const scene = after.scenes.filter((s: { projectId: string }) => s.projectId === after.projects.at(-1).id).at(-1);
  expect(sent.images).toEqual([scene.files["candidate/preview.png"]]);
  expect(sent.prompt).not.toContain("preview.png");
  expect(errors).toEqual([]);
});

test("second part family: 6202 pillow block from the CAD form, single-fault preset rejected on the bearing seat, phone width", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad?.families?.["pillow-block"]) throw new Error("CadQuery with the pillow-block family is required");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }).click();
  await expect(page.getByRole("heading", { name: /6202 轴承座/ })).toBeVisible();
  await expect(page.getByText("结构要求（Gmsh + CalculiX 线性静力 FEA）")).toHaveCount(0);
  await page.getByRole("radio", { name: /轴承孔偏小/ }).check();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 180_000 });
  const fail = page.locator(".check-table tr.fail");
  await expect(fail).toHaveCount(1); await expect(fail).toContainText("轴承孔（H7）"); await expect(fail).toContainText("34.95");
  await expect(page.locator(".outliner").getByText("6202 bearing")).toBeVisible();
  // The failure goes through feedback; the recheck rebuilds the family's own reference, never the bracket.
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  await page.getByRole("button", { name: /记录反馈：CAD 轴承孔/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测"], 180_000);
  const after = await (await page.request.get("/api/state")).json();
  const recheck = after.cads.filter((x: { feedbackId?: string }) => x.feedbackId).at(-1);
  expect(recheck.request.variant).toBe("pillow-block"); expect(recheck.verdict).toBe("accepted-cad-part");
  // Generated code for this family: the editor switches to the housing template, which passes in the sandbox.
  if (state.capabilities.cad.generatedCode?.available) {
    await rail(page, /候选设计/).click();
    await page.getByRole("tab", { name: "CAD 零件" }).click();
    await page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }).click();
    await page.getByRole("radio", { name: /生成代码|代码/ }).first().check();
    await expect(page.locator("#cad-code")).toHaveValue(/AXIS_Z = 30\.0/);
    await page.getByRole("button", { name: "在沙箱中运行并检查" }).click();
    await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 180_000 });
    await expect(page.locator(".check-table")).toContainText("轴承孔（H7）");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("pillow-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("CAM from the CAD form: G-code per setup, independent simulation, programs downloadable at phone width", async ({ page }, testInfo) => {
  test.setTimeout(1_500_000);
  const state = await (await page.request.get("/api/state")).json();
  test.skip(!state.capabilities.cad?.cam, "CAM toolchain not installed (npm run setup:cam)");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("radio", { name: /基准设计/ }).check();
  await page.getByRole("checkbox", { name: "冻结制造要求并做 DFM" }).check();
  const camBox = page.getByRole("checkbox", { name: "生成 G-code 并做切削仿真（CAM）" });
  await camBox.check(); await expect(camBox).toBeChecked();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 1_400_000 });
  const table = page.locator(".check-table");
  await expect(table.locator("tr", { hasText: "CAM 刀路仿真" })).not.toHaveClass(/fail/);
  await expect(table.locator("tr", { hasText: "加工节拍（CAM）" })).toContainText("min");
  const programs = page.getByRole("group", { name: "CAM 程序" });
  await expect(programs.getByRole("link", { name: /下载 G-code · 装夹/ })).toHaveCount(2);
  const nc = await page.request.get(await programs.getByRole("link", { name: "下载 G-code · 装夹 +Z" }).getAttribute("href") as string);
  expect(nc.status()).toBe(200); expect(await nc.text()).toMatch(/G21[\s\S]*M2/);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("cam-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
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
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"], 150_000);
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
  // CAD checks are a measured table; a failed row carries the rule name and an "ask AI" action.
  await expect(page.locator(".check-table tr.fail")).toHaveCount(1);
  await expect(page.locator(".check-table tr.fail")).toContainText("最小壁厚");
  // ~85 kB SVG drawings decode after the native run; allow for a loaded CI runner.
  await expect.poll(() => page.locator(".drawings img").evaluateAll(images => images.length === 2 && images.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)),
    { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  const step = await page.request.get(await page.getByRole("link", { name: "下载可编辑 STEP" }).getAttribute("href") as string);
  expect(step.status()).toBe(200); expect((await step.text()).startsWith("ISO-10303-21")).toBe(true);
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"], 180_000);
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
  await advance(page, ["记录复现", "分配处理", "提出回退方案", "按修正方案复测"], 180_000);
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
  const reviewsBefore = (await (await page.request.get("/api/state")).json()).reviews.length;
  await assistant.getByRole("article", { name: "计划 相机偏移记录评审" }).getByRole("button", { name: "确认执行" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未核对");
  expect((await (await page.request.get("/api/state")).json()).reviews.length, "an unreconciled plan must not start a native run").toBe(reviewsBefore);
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.locator("#studio-input").fill("还有别的吗");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(page.getByRole("alert")).toContainText("尚未核对");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await assistant.getByRole("button", { name: "记录核对结果" }).click();
  await expect(assistant.getByText(/已核对 · local-maintainer/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-desktop.png") });
  const state = await (await page.request.get("/api/state")).json();
  // Only this test's project: other specs share the server and also create model runs.
  const mine = state.projects.at(-1).id;
  const runs = state.assistantPlans.filter((p: { source?: string; projectId?: string }) => p.source === "model" && p.projectId === mine);
  expect(runs.map((p: { state: string }) => p.state)).toEqual(["done", "reconcile"]);
  expect(runs.every((p: { authority: string }) => p.authority === "none")).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("MCP: an external agent reads the workspace and proposes; only the maintainer's confirmation runs native CAD", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  const client = new Client({ name: "Kiro CLI", version: "2.24.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"],
    env: { PATH: process.env.PATH ?? "", PAI_URL: new URL(baseURL!).origin }, stderr: "pipe" }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError, r.content[0].text).toBeFalsy();
    return JSON.parse(r.content[0].text);
  };
  try {
    const projectId = (await call("pai_list_projects")).at(-1).id;
    const ws = await call("pai_get_workspace", { projectId });
    expect(Object.keys(ws.tools)).toContain("cad-review");
    const proposed = await call("pai_propose_plan", { projectId, intent: "评估紧凑化支架是否满足壁厚 3 mm",
      plans: [{ ref: "p1", tool: "cad-review", title: "紧凑化支架评审", payload: { variant: "compact" } }] });
    expect(proposed.authority).toBe("none");
    await page.reload();
    const assistant = page.getByRole("complementary", { name: "AI 助手" });
    await expect(assistant.getByText("外部 Agent · Kiro CLI")).toBeVisible();
    const card = assistant.getByRole("article", { name: "计划 紧凑化支架评审" });
    expect((await call("pai_get_plan", { planId: proposed.planId })).steps[0].confirmed).toBeNull();
    await card.getByRole("button", { name: "确认执行" }).click();
    await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 180_000 });
    const status = await call("pai_get_plan", { planId: proposed.planId });
    expect(status.steps[0].confirmed).toMatchObject({ recordKind: "cad-review", match: "as-proposed" });
    const record = await call("pai_get_record", { projectId, handle: "cad-1" });
    expect(record.id).toBe(status.steps[0].confirmed.recordId);
    expect(record.record.verdict).toBe("rejected");
    expect((await call("pai_get_admission", { projectId, handle: "cad-1" })).admissible).toBe(false);
    // The backend receipt precedes the UI refresh/final GLB handoff. Check the
    // completed visible result before resizing the still-streaming viewport.
    await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".viewport-hud.top-left")).toContainText("最终 GLB（摘要已核验）", { timeout: 60_000 });
  } finally { await client.close(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("generated CadQuery code: policy check, sandboxed build, native failure, recheck with revised code; AI code plan", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.cad?.generatedCode?.available) throw new Error(`Sandbox required: ${state.capabilities.cad?.generatedCode?.reason}`);
  const template: string = state.capabilities.cad.generatedCode.template;
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  // The intended policy rejection surfaces as a toast; Chrome also logs it as a resource error.
  page.on("console", m => { if (m.type() === "error" && !/status of 422/.test(m.text())) errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await page.getByRole("radio", { name: /生成代码/ }).check();
  const editor = page.getByRole("textbox", { name: /CadQuery 代码/ });
  await expect(editor).toHaveValue(template);
  await editor.fill(template.replace("import cadquery as cq", "import cadquery as cq\nimport os"));
  await page.getByRole("button", { name: "检查代码策略" }).click();
  await expect(page.locator(".violations")).toContainText("发现 os");
  await editor.fill(template.replace("T = 4.0 ", "T = 2.5 "));
  await page.getByRole("button", { name: "检查代码策略" }).click();
  await expect(page.getByText("符合沙箱策略")).toBeVisible();
  await page.getByRole("button", { name: "在沙箱中运行并检查" }).click();
  await expect(page.getByRole("heading", { name: "零件检查拒绝" })).toBeVisible({ timeout: 240_000 });
  // CAD checks are a measured table; a failed row carries the rule name and an "ask AI" action.
  await expect(page.locator(".check-table tr.fail")).toHaveCount(1);
  await expect(page.locator(".check-table tr.fail")).toContainText("最小壁厚");
  await expect(page.locator(".code-source summary")).toContainText("沙箱结果 已生成实体");
  await page.getByRole("button", { name: "查看证据与回放 →" }).click();
  await page.getByRole("button", { name: /记录反馈：CAD 最小壁厚/ }).click();
  await advance(page, ["记录复现", "分配处理", "提出回退方案"]);
  await page.getByRole("button", { name: "修订代码并复测", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "反馈复测" })).toBeVisible();
  await expect(editor).toHaveValue(template.replace("T = 4.0 ", "T = 2.5 "));
  await editor.fill(template.replace("T = 4.0 ", "T = 3.5 "));
  await page.getByRole("button", { name: "提交修订代码并复测" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 240_000 });
  await expect.poll(async () => (await (await page.request.get("/api/state")).json()).feedback.at(-1).status, { timeout: 30_000 }).toBe("rechecked");

  // An AI-written code plan: shown as code, refused parts listed, executed only on confirmation.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(".state/browser/fake-executor.json", JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({ kind: "plan", plans: [
    { ref: "p1", tool: "cad-code", title: "AI 生成：加宽底板", payload: { code: template.replace("W = 60.0 ", "W = 64.0 ") } },
    { ref: "p2", tool: "cad-code", title: "越权", payload: { code: template + "\nx = open('/etc/passwd')\n" } }] }) + "\n```" }] }));
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await assistant.getByRole("button", { name: "AI 引擎", exact: true }).click();
  await assistant.locator("#studio-input").fill("写一个加宽底板的支架代码");
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  await expect(assistant.getByText(/已拒绝 AI 计划 p2（cad-code）：代码不符合沙箱策略/)).toBeVisible({ timeout: 60_000 });
  const card = assistant.getByRole("article", { name: "计划 AI 生成：加宽底板" });
  await card.getByText("查看生成的 CadQuery 代码").click();
  await expect(card.locator("pre.code")).toContainText("W = 64.0");
  await card.getByRole("button", { name: "确认执行" }).click();
  await expect(card.getByText(/已执行 · 与计划一致/)).toBeVisible({ timeout: 240_000 });
  await page.screenshot({ path: testInfo.outputPath("cad-code-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("design-space sweep: native points on a scatter, lightest feasible point becomes a normal accepted candidate", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  const panel = page.locator(".card", { has: page.getByRole("heading", { name: "设计空间扫描" }) });
  await panel.getByRole("textbox", { name: /板厚 t/ }).fill("2.5, 3, 4");
  await panel.getByRole("textbox", { name: /宽度 W/ }).fill("60");
  await panel.getByRole("textbox", { name: /安装板高度 H/ }).fill("46");
  await expect(panel.getByText(/^3 个点/)).toBeVisible();
  await panel.getByRole("button", { name: "运行扫描" }).click();
  await expect(panel.getByRole("group", { name: "质量与最小壁厚散点图" })).toBeVisible({ timeout: 240_000 });
  await expect(panel.getByText(/3 个点中 2 个满足全部 7 项检查/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /点 \d：t=2.5 .*未通过 最小壁厚/ })).toBeVisible();
  // Default selection is the lightest feasible point; keyboard selection works on the plot.
  await expect(panel.locator(".sweep-pick")).toContainText("t=3 · W=60 · H=46");
  await panel.getByRole("button", { name: /点 \d：t=4 / }).press("Enter");
  await expect(panel.locator(".sweep-pick")).toContainText("t=4");
  await panel.getByRole("button", { name: /点 \d：t=3 / }).click();
  await panel.getByRole("button", { name: "以此参数生成正式候选" }).click();
  await expect(page.getByRole("heading", { name: "零件检查通过" })).toBeVisible({ timeout: 240_000 });
  const state = await (await page.request.get("/api/state")).json();
  const cad = state.cads.at(-1);
  expect(cad.request).toMatchObject({ variant: "parametric", parameters: { thickness: 3, width: 60, plateHeight: 46 } });
  expect(cad.request.fromSweep.sweepId).toBe(state.cadSweeps.at(-1).id);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "CAD 零件" }).click();
  await expect(panel.getByRole("button", { name: "查看已生成的候选 →" })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: /板厚 t/ })).toHaveValue("2.5, 3, 4");
  await expect(panel.getByText(/^3 个点/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("sweep-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("factory production line: native Blender build streams into the viewport, ray-measured rejection, animation and an AI layout fix plan", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.blender) throw new Error("Native Blender is required for this integration check");
  await createProject(page);
  await page.goto("/#/design?lane=plant");
  for (const [label, value] of [["工位数", "6"], ["工位节距", "4.5"], ["AGV 通道设计宽度", "2.4"], ["安全围栏边长", "4.2"], ["检测相机龙门高度", "2.8"], ["AGV 台数", "3"]]) {
    await page.getByLabel(label, { exact: true }).fill(value, { timeout: 15_000 });
  }
  await expect(page.locator(".plant-estimate")).toContainText("626 m²");
  await page.getByRole("button", { name: "生成并检查工厂产线" }).click();
  await expect(page.getByLabel("实时工具步骤").first().getByText("Blender 参考产线（4 工位）")).toBeVisible({ timeout: 60_000 });
  const viewport = page.locator(".viewport");
  await expect(viewport).toHaveAttribute("data-stage", "8", { timeout: 300_000 });
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 600_000 });
  const row = page.locator(".check-table tr.fail");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("AGV 通道净宽"); await expect(row).toContainText("2.08"); await expect(row).toContainText("≥ 2.4");
  await expect(page.locator(".viewport-hud.bottom-left")).toContainText("6/6");
  await expect(viewport).not.toHaveAttribute("data-animations", "0", { timeout: 30_000 });
  await page.getByRole("button", { name: "▶ 播放产线动画" }).click();
  await expect(viewport).toHaveAttribute("data-playing", "true");
  for (const name of ["候选产线原生 Cycles 渲染", "参考产线原生 Cycles 渲染"]) {
    await expect.poll(() => page.getByRole("img", { name }).evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(400);
  }
  await expect.poll(() => page.locator(".plant-renders img").nth(1).evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(300);
  await page.screenshot({ path: testInfo.outputPath("plant-desktop.png") });
  // The failing measurement becomes a typed AI plan; the scripted executor stands in for the model.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(".state/browser/fake-executor.json", JSON.stringify({ attempts: [{ profile: "kiro-primary", status: "succeeded", answer: "```json\n" + JSON.stringify({
    kind: "plan", interpretation: ["4.2 m 围栏比参考围栏宽 0.6 m，挤占 0.3 m 通道"],
    answer: { text: "scene-1 的通道净宽实测 2.08 m < 2.4 m。把设计通道加宽到 2.8 m，占地 641.6 m² 仍 ≤ 650 m²。", citations: ["scene-1"] },
    plans: [{ ref: "p1", tool: "plant-layout", title: "加宽 AGV 通道复测", payload: { layout: { stations: 6, stationPitch: 4.5, aisleWidth: 2.8, guardSize: 4.2, rackRows: 2, cameraHeight: 2.8, agvs: 3 } } }] }) + "\n```" }] }));
  await row.getByRole("button", { name: /问 AI：AGV 通道净宽为什么未通过/ }).click();
  const assistant = page.getByRole("complementary", { name: "AI 助手" });
  await expect(assistant.locator("#studio-input")).toHaveValue(/AGV 通道净宽.*2\.08/);
  await assistant.getByRole("button", { name: "生成计划 ↵" }).click();
  const card = assistant.getByRole("article", { name: "计划 加宽 AGV 通道复测" });
  await expect(card.getByText("2.4 → 2.8")).toBeVisible();
  await expect(assistant.getByRole("group", { name: "引用的记录" }).last()).toContainText("Blender 场景 · plant");
  await card.getByRole("button", { name: "在专业面板调整" }).click();
  await expect(page.getByLabel("AGV 通道设计宽度", { exact: true })).toHaveValue("2.8");
  await expect(page.locator(".plant-estimate")).toContainText("642 m²");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/validate?kind=blender-scene");
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("plant-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("physics lanes: FEA stress view on a CAD review and a MuJoCo robot cell with paired seeds", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.physics) throw new Error("The pinned physics toolchain is required for this integration check");
  await createProject(page);
  await page.goto("/#/design?lane=robotcell");
  await page.getByLabel("关节速度", { exact: true }).fill("75");
  await page.getByLabel("围栏离最远工位", { exact: true }).fill("0.12");
  await page.getByLabel("节拍上限", { exact: true }).fill("5");
  await page.getByRole("button", { name: "仿真并检查工作单元" }).click();
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 300_000 });
  const fail = page.locator(".check-table tr.fail");
  await expect(fail.filter({ hasText: "运动无碰撞" })).toHaveCount(1);
  await expect(page.locator(".viewport")).toHaveAttribute("data-objects", /[1-9]/, { timeout: 60_000 });
  await expect(page.getByRole("table", { name: "配对种子（同一来料偏差）" }).locator("tbody tr")).toHaveCount(10);
  await page.screenshot({ path: testInfo.outputPath("robot-cell.png") });
  await page.goto("/#/design?lane=cad");
  await page.getByRole("radio", { name: /参数化/ }).check();
  await page.getByLabel("板厚 t", { exact: true }).fill("3");
  await page.getByLabel("冻结结构要求并做 FEA").check();
  await expect(page.getByLabel("电机轴挠度上限", { exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "生成并检查 CAD 零件" }).click();
  await expect(page.getByRole("heading", { name: /零件检查(通过|拒绝)/ })).toBeVisible({ timeout: 600_000 });
  await expect(page.locator(".check-table")).toContainText("电机轴挠度（FEA）");
  // Geometry accepts t = 3 mm; only the native FEA rejects it.
  await expect(page.locator(".check-table tr.fail")).toHaveCount(1);
  await expect(page.locator(".check-table tr.fail")).toContainText("电机轴挠度（FEA）");
  await expect(page.getByRole("group", { name: "FEA 结果" })).toContainText("CalculiX");
  await expect(page.locator(".viewport")).toHaveAttribute("data-objects", /[1-9]/, { timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("fea-view.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("robot cell closed loop in the UI: MuJoCo rejection, fixed cell, feedback recheck, release and a signed package", async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const state = await (await page.request.get("/api/state")).json();
  if (!state.capabilities.physics) throw new Error("The pinned physics toolchain is required for this integration check");
  await createProject(page);
  const runCell = async (guard: string) => {
    await page.goto("/#/design?lane=robotcell");
    await page.getByLabel("关节速度", { exact: true }).fill("75");
    await page.getByLabel("围栏离最远工位", { exact: true }).fill(guard);
    await page.getByLabel("节拍上限", { exact: true }).fill("5");
    await page.getByRole("button", { name: "仿真并检查工作单元" }).click();
  };
  await runCell("0.12");
  await expect(page.getByRole("heading", { name: "场景检查拒绝" })).toBeVisible({ timeout: 300_000 });
  await page.getByRole("button", { name: /记录反馈：MuJoCo 运动无碰撞/ }).click();
  await expect(page.getByRole("heading", { name: "反馈复测", level: 1 })).toBeVisible();
  await advance(page, ["记录复现", "分配处理", "提出回退方案"]);
  // No accepted fix yet: the recheck refuses instead of inventing one.
  await page.getByRole("button", { name: "按修正方案复测", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("先提交并通过一个修正方案");
  await page.getByRole("alert").getByRole("button", { name: "关闭通知" }).click();
  await runCell("0.3");
  await expect(page.getByRole("heading", { name: "静态场景检查通过" })).toBeVisible({ timeout: 300_000 });
  await rail(page, /反馈复测/).click();
  await page.locator(".run-list .run").first().click();
  await advance(page, ["按修正方案复测", "关闭已复测反馈"], 300_000);
  await rail(page, /发布交付/).click();
  await expect(page.getByLabel("发布准入检查").locator(".check-item.pass")).toHaveCount(5);
  await page.getByRole("button", { name: "创建发布候选" }).click();
  await page.getByRole("button", { name: "批准发布 R1" }).click();
  await expect(page.getByRole("button", { name: /成熟度：R1 已发布/ })).toBeVisible();
  const link = page.getByRole("link", { name: "下载签名发布包" });
  await expect(link).toBeVisible();
  const pkg = await (await page.request.get(await link.getAttribute("href") as string)).json();
  const key = await (await page.request.get("/api/signing/public-key")).json();
  const verified = await (await page.request.post("/api/packages/verify", { data: { package: pkg, trustedPublicKeyPem: key.publicKeyPem } })).json();
  expect(verified.valid).toBe(true); expect(verified.signer.trusted).toBe(true);
  expect(Object.keys(pkg.files)).toContain("candidate/scene.xml");
  await page.getByRole("button", { name: "核验签名" }).click();
  await expect(page.getByRole("status").filter({ hasText: "签名有效" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("robot-release.png") });
  expect(errors).toEqual([]);
});

test("aerodynamics lane: form submits the typed request and the API refuses an out-of-range body", async ({ page }) => {
  const state = await (await page.request.get("/api/state")).json();
  await createProject(page);
  await rail(page, /候选设计/).click();
  await page.getByRole("tab", { name: "车身气动" }).click();
  if (!state.capabilities.aero) {
    // Without a pinned OpenFOAM image the lane says so and offers no solve button (fail closed, no fabricated result).
    await expect(page.getByText(/未配置 OpenFOAM/)).toBeVisible();
    await expect(page.getByRole("button", { name: "求解并检查车身" })).toHaveCount(0);
  } else {
    // Intercept the solve: this browser check covers the form and request contract; npm run test:aero covers OpenFOAM.
    let sent: Record<string, unknown> | undefined;
    await page.route("**/api/projects/*/aero", route => { sent = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { error: "TEST_INTERCEPT", message: "intercepted" } }); });
    await page.getByLabel("后斜角", { exact: true }).fill("12.5");
    await page.getByRole("button", { name: "求解并检查车身" }).click();
    await expect.poll(() => sent?.parameters).toEqual({ slantAngleDeg: 12.5, noseRadius: 0.1, length: 1.044, height: 0.288 });
    expect(sent?.requirements).toEqual(state.capabilities.aero.defaultRequirements);
  }
  const project = (await (await page.request.get("/api/state")).json()).projects.at(-1);
  const bad = await page.request.post(`/api/projects/${project.id}/aero`, { data: { requestId: crypto.randomUUID(), projectRevision: project.revision,
    parameters: { slantAngleDeg: 60, noseRadius: 0.1, length: 1.044, height: 0.288 } }, headers: { origin: new URL(page.url()).origin } });
  expect(bad.status()).toBeGreaterThanOrEqual(400);
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
});
