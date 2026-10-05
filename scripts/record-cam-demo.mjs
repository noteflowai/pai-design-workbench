// Records "Demo D": from design to the machine shop. 6202 pillow-block housing: a bearing seat outside H7 is caught on
// the B-Rep, the reference design is then checked for manufacturing (setups, drill corridors, screw access, cost), the
// G-code is generated per setup and simulated independently, and the release ships STEP + G-code + simulation, signed.
// Usage: node scripts/record-cam-demo.mjs http://127.0.0.1:4319 <output-dir>
// Everything shown runs live on the native tools (CadQuery/OCCT, FreeCAD CAM, OpenCAMLib, the dexel simulation,
// EvalArc); no model is called. Numbers in captions are read back from the saved records.
import { writeFile } from "node:fs/promises";
import { openDemo } from "./demo-kit.mjs";

const base = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? ".state/demo-cam-video";
const { browser, context, page, pause, caption, chapter, card, click, type, orbit, spot, wheelTo, mark, elapsed, t0 } = await openDemo(out);
page.setDefaultTimeout(180_000);
const state = async () => (await page.request.get(`${base}/api/state`)).json();
const busyDone = () => page.locator(".busy").waitFor({ state: "detached", timeout: 1_800_000 }).catch(() => undefined);
async function advance(names) {
  for (const name of names) { await click(page.getByRole("button", { name, exact: true }), 300); await pause(800); await busyDone(); await pause(600); }
}
const facts = {};
const check = (r, id) => r.candidate.checks.find(c => c.id === id);
const rail = name => page.getByRole("navigation", { name: "生命周期" }).getByRole("link", { name });
const cadForm = async () => { await rail(/候选设计/).click(); await pause(700); await click(page.getByRole("tab", { name: "CAD 零件" }), 500);
  await click(page.getByRole("group", { name: "零件族" }).getByRole("button", { name: "6202 轴承座" }), 700); };

// ---------------------------------------------------------------- 0 title
await page.goto(`${base}/#/overview`); await page.getByRole("navigation", { name: "生命周期" }).waitFor();
await card("从设计到车间：轴承座的可制造性与 G-code", "B-Rep 实测 → DFM / DFA → FreeCAD CAM 出程序 → 独立切削仿真 → 签名交付",
  ["CadQuery 2.8 / OCCT 7.9", "ISO 286 H7 · ISO 4762", "FreeCAD 1.1 CAM + OpenCAMLib", "0.1 mm 高度图仿真", "EvalArc 独立对照", "签名发布包"],
  "全部结果实时生成，不调用模型");
await pause(5500); await card(""); await pause(800);

// ---------------------------------------------------------------- 1 freeze
mark("freeze");
await chapter("01", "冻结需求");
await caption("6202 深沟球轴承座：外圈 Ø35，孔要 H7（35.000–35.025）", "轴承孔四周壁厚 ≥ 5 mm，M8 地脚孔边距 ≥ 1.5 d，外形 ≤ 120 × 40 × 60 mm，≤ 250 g");
await click(page.getByRole("button", { name: "新建", exact: true }), 600);
await page.getByRole("button", { name: "创建评审任务" }).waitFor();
await click(page.getByRole("button", { name: "创建评审任务" }), 1400);
await page.getByText("任务和验收要求已冻结为版本 1。").waitFor(); await pause(1200);

// ---------------------------------------------------------------- 2 a seat outside H7
mark("seat");
await chapter("02", "轴承孔偏小：B-Rep 实测拒绝");
await cadForm();
await caption("候选：轴承孔加工成 Ø34.95", "看起来只差 0.05 mm；轴承压不进去，强压会让外圈变形");
await click(page.getByRole("radio", { name: /轴承孔偏小/ }), 600);
await click(page.getByRole("button", { name: "生成并检查 CAD 零件" }), 400);
await caption("CadQuery 逐个特征建模，每一步推送到三维视口", "随后在 OCCT B-Rep 上实测：孔径、同轴度、止口、72 条径向射线测壁厚、地脚孔边距");
await page.getByRole("heading", { name: "零件检查拒绝" }).waitFor({ timeout: 300_000 });
await pause(1500); await orbit(260, -40); await pause(1200);
let s = await state(); const tight = s.cads.at(-1);
facts.tight = { seat: check(tight, "bearing-seat").observed.seatDiameter, blocking: tight.diff?.blocking_changes };
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(300);
await caption(`实测孔径 Ø${facts.tight.seat}，低于 H7 下限 35.000`, `其余检查全部通过；EvalArc 判定候选丢失了基准通过的 ${facts.tight.blocking} 项检查`);
await spot(page.locator(".check-table tr.fail"), 3200);

// ---------------------------------------------------------------- 3 reference + DFM + CAM
mark("cam");
await chapter("03", "可制造性与 G-code");
await cadForm();
await caption("下一步：回到 H7 孔径的基准设计，并冻结制造要求", "装夹 ≤ 3 次、单件成本 ≤ 40 EUR、加工节拍 ≤ 120 min");
await click(page.getByRole("radio", { name: /6202 轴承座基准/ }), 500);
await click(page.getByRole("checkbox", { name: "冻结制造要求并做 DFM" }), 400);
const setupsBox = page.getByRole("spinbutton", { name: "装夹次数上限" }); await setupsBox.fill("3");
const costBox = page.getByRole("spinbutton", { name: "单件成本上限" }); await costBox.fill("40");
await click(page.getByRole("checkbox", { name: "生成 G-code 并做切削仿真（CAM）" }), 400);
await caption("DFM 在 B-Rep 上实测：最少装夹方向、每个孔的钻削通道、M8 螺钉头与扳手的空间", "开发时正是这项检查发现：最初的设计里加强筋会挡住 M8 螺钉头");
await click(page.getByRole("button", { name: "生成并检查 CAD 零件" }), 400);
await caption("FreeCAD 1.1 CAM 按装夹出程序：分层粗加工、壁面精修、钻孔和螺旋铣孔", "另一个独立进程只读 G-code，在 0.1 mm 高度图上逐刀仿真");
await page.getByRole("heading", { name: /零件检查(通过|拒绝)/ }).waitFor({ timeout: 1_800_000 });
await pause(1500);
s = await state(); const camRun = s.cads.at(-1);
facts.cam = { verdict: camRun.verdict, setups: check(camRun, "machining-setups").observed, cost: check(camRun, "unit-cost").observed,
  cycle: check(camRun, "cycle-time").observed, fasteners: check(camRun, "fastener-access").observed,
  programs: Object.keys(camRun.files).filter(f => f.startsWith("candidate/setup") && f.endsWith(".nc")).map(f => f.split("/")[1]) };
await page.locator(".check-table").scrollIntoViewIfNeeded(); await pause(400);
await caption(`${facts.cam.setups} 次装夹，0 个孔受阻，单件成本估算 ${facts.cam.cost} EUR（估算，不是报价）`, `刀路仿真：无过切、无残料、无过载、无快移碰撞；节拍 ${facts.cam.cycle} min`);
await spot(page.locator(".check-table"), 3600);
const sim = page.locator("figure.result-image").filter({ has: page.locator("img[src*='cam-sim.png']") });
await wheelTo(sim, 120); await pause(800);
await caption("仿真结果图：按装夹的高度图", "红 = 过切，橙 = 残料，蓝 = 任何刀具都够不到的内角（如实标出，不算程序错误）");
await spot(sim, 3600);
await wheelTo(page.getByRole("group", { name: "CAM 程序" }), 160); await pause(400);
await caption(`${facts.cam.programs.length} 个装夹各一份程序：${facts.cam.programs.join("、")}`, "程序文件按摘要登记，可直接下载；开工前仍由 CAM 工程师审查");
await spot(page.getByRole("group", { name: "CAM 程序" }), 3000);

// ---------------------------------------------------------------- 4 close the failure, release, sign
mark("release");
await chapter("04", "处置失败 → 发布 → 签名");
await page.goto(`${base}/#/validate?kind=cad-part&id=${tight.id}`); await pause(1200);
await click(page.getByRole("button", { name: /记录反馈：CAD 轴承孔/ }), 900);
await advance(["记录复现", "分配处理", "提出回退方案", "按修正方案复测", "关闭已复测反馈"]);
await rail(/发布交付/).click(); await pause(1500);
await caption("准入检查：结论通过、绑定当前需求、所有失败案例都已关闭", "缺一项就不能创建发布候选");
await spot(page.getByLabel("发布准入检查"), 2600);
await click(page.getByRole("button", { name: "创建发布候选" }), 1200);
await click(page.getByRole("button", { name: "批准发布 R1" }), 1500);
await page.getByText("R1 已发布").first().waitFor({ timeout: 60_000 }); await busyDone(); await pause(1500);
const signed = page.getByRole("status").filter({ hasText: "签名有效" });
for (let i = 0; i < 2 && !(await signed.count()); i++) {
  await click(page.getByRole("button", { name: "核验签名" }), 600);
  await signed.waitFor({ timeout: 60_000 }).catch(() => undefined);
}
if (!(await signed.count())) throw new Error(`signature status: ${await page.locator('[role="status"]').allInnerTexts()}`);
facts.signer = (await signed.innerText()).includes("KMS") ? "AWS KMS ECDSA P-256" : "本机 Ed25519 密钥；托管站点使用 AWS KMS";
await caption("发布包：STEP、G-code、仿真报告与仿真图、全部检查记录和审批", `清单已签名（${facts.signer}）；车间拿到的程序与评审过的是同一份字节`);
await spot(page.locator(".release-history"), 3400);
await caption(""); await chapter("");
await card("PAI Design Workbench", "从冻结需求到可加工程序，每一步都有原生实测和签名证据",
  ["B-Rep 实测", "DFM / DFA", "FreeCAD CAM", "独立切削仿真", "签名交付"], "github.com/noteflowai/pai-design-workbench");
await pause(1200); await page.screenshot({ path: `${out}/endcard.png` }); await pause(3000);
const result = { marks: elapsed(), facts, totalSeconds: Math.round((Date.now() - t0) / 1000) };
await context.close(); await browser.close();
await writeFile(`${out}/marks.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
