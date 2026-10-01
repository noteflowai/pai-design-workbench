# 实际验证记录

2026-09-30，最新 Node 24.21.0 LTS、TypeScript 7.0.2、Blender 5.2.2 LTS。

## MCP 服务器（2026-10-01）

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 47 组通过。MCP 新增 3 组：工具清单恰好 7 个、不含任何确认/执行/发布/反馈/核对工具，读取类工具都标注为只读；提议按同一套契约校验（放宽 minWallMm 3 → 2.5 被标出，`approve-release` 与不符合 schema 的 payload 被拒绝，虚构的 `cad-7` 引用返回 `INVALID_CITATION`，没有有效计划返回 `NO_VALID_PLAN`），相同 `requestId` 不重复，提议本身不运行原生工具；只接受回环地址（拒绝 HTTPS、内网 IP、伪装域名、带用户信息或路径的 URL） |
| `npm run test:browser` | 9 组通过。新增 MCP 流程：以 “Kiro CLI” 为客户端名的 stdio 客户端读取工作区并提议 compact 方案；界面显示“外部 Agent · Kiro CLI”；维护者确认后运行原生 CadQuery；Agent 读取到 as-proposed 确认、拒绝结论，准入检查为不可准入；390 px 无溢出 |
| 构建产物 | `node dist/src/mcp.js` 完成握手，列出 7 个工具；`PAI_URL=https://pai.oneai.host` 以退出码 1 拒绝启动 |

## 0.4.0 单一镜像与托管 AI（2026-10-01）

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 44 组通过。AI 4 组：Kiro 回退后计划按同一契约重新校验；虚构引用、未知工具和越权工具被拒绝；引擎影响未核实（含执行器无报告）时阻止确认和新的运行；未配置时禁用，工作区文本只作为数据出现在提示中 |
| `npm run test:browser` | 8 组通过。AI 组使用假执行器，不消耗真实尝试，覆盖回退链、引用跳转、计划确认、核对门槛，并断言时间线滚动后气泡、引用和计划卡互不重叠 |
| 本地真实引擎 | Kiro 主账号 2 次完成（答案带引用，计划有效）；Claude 结果需核对，已人工核对；Codex 被执行器在开始前拒绝（模型广播冲突，属执行器侧问题，未修改） |
| 容器 `pai-workbench:0.4.0` | 7.0 GB，仅 amd64。容器内原生 CAD 得到 min-wall 失败；Kiro 主账号回答，引用 `cad-1`，给出两个壁厚 3 mm 的复测计划。镜像历史中没有密钥。见[回执](evidence/container.json) |
| pai.oneai.host | 通过 Cognito 登录后：能力清单只列出 Kiro 三个账号；真实 Kiro 主账号用时 30 s 完成，引用 3 条已存记录，两个计划均通过校验；确认执行 compact 方案，原生检查得出的拒绝结论保留；跨源和匿名 AI 请求被拒绝；390 px 无溢出，控制台无错误。见[回执](evidence/deployment-ai.json)、[基础设施](evidence/deployment-infra-v040.json)、[截图](evidence/cloud-ai.png) |

托管上线过程中发现并修复了三个问题：安装脚本的 stdout 混入了构建输出；主机上的 boto3 没有默认区域；systemd 的 `ProtectSystem=strict` 让 HOME 只读，Kiro 在握手前就退出。前两个问题导致发布中止，但旧版本一直在服务。第三个问题让首次托管调用以 `transport`（开始前失败）结束，没有回退，已人工核对，没有重放；之后用不发送提示的协议探针确认修复有效。截图还发现一个 CSS 选择器冲突：回答气泡继承了侧栏的 sticky 样式，导致内容重叠。已修复，并加入浏览器回归测试，确认该测试在旧样式下会失败。

## 生命周期界面、参数化 CAD 与典型用例（2026-10-01）

初次本地验证使用 Node 22.23.3；发布隔离副本再次使用 Node 24.21.0 LTS 完成所有检查，CI 另用 24.21 LTS / 26.10 Current；Blender 5.2.2 LTS；CadQuery 2.8.0 / OCCT 7.9.3（哈希锁定）；Chromium 使用 SwiftShader WebGL。

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 类型检查、39 组单元/接口测试、生产构建通过。新增：生命周期推导 3 组（阶段、下一步、失败案例去重、运行优先）、CAD 3 组（意图计划与放宽方向、反馈只能绑定丢失基准通过的检查、未配置时 503、拒绝未知文件和额外字段） |
| `npm run test:cad` | 轻量化候选只有 min-wall 失败；止口孔候选失败 interface 与 interference；紧凑候选失败 hole-edge-distance；未修复不能复测关闭；改变需求的复测被拒绝；恢复基准后关闭；STEP 重导入体积一致、孔径 3.4/5.5/22.5。见[回执](evidence/cad-e2e.json) |
| `npm run test:suite` | [14 个典型工业设计用例](INDUSTRIAL_TEST_CASES.md)全部与预期一致。见[回执](evidence/industrial-suite.json) |
| `npm run test:native`、`npm run test:blender` | 通过，结果不变 |
| `npm run test:browser` | 6 组通过：登录态 390px 布局；完整生命周期（需求 → 验证 → 回放 → 反馈复测 → 交付 → 需求修订 v2，六个阶段全部完成）；Blender 表单闭环；AI 计划驱动的实时 Blender 视口；工厂孪生；CAD 实时 B-Rep 构建、测量失败、工程视图、STEP 下载与恢复参数复测。全部 390px 无横向溢出、无控制台错误 |

界面复查：在 1440、1280、1024、768、390 px 下逐页（总览、需求、四条设计通道、验证、证据、反馈、交付）自动检查横向溢出、控件裁切、触控尺寸、无名控件和浮层遮挡，并检查键盘顺序与命令面板。据此修正：1024–1279 px 停靠助手时左栏收为图标栏，保证工作区 ≥ 560 px；1024 px 以下助手改为带遮罩的弹出层（点遮罩或 Esc 关闭）；视口工具按钮 ≥ 32 px；窄屏阶段栏与标签自动滚动到当前项；反馈页直接列出尚未记录反馈的失败案例；工厂检查说明改为中文；标题聚焦不再显示焦点框。浏览器测试新增“助手不遮挡工作区”断言（1024/1280/1440 px）。

截图：[总览](evidence/overview-desktop.png)、[CAD](evidence/cad-desktop.png)、[CAD 手机](evidence/cad-mobile.png)。演示视频由 `scripts/record-demo.mjs` 在本地实际录制，原生计算全程真实执行；`tools/render_demo.py` 用 ffmpeg freezedetect 找出画面静止的等待片段并按 6 倍速播放，不剪切、不调换顺序。

## 0.2.1 发布与云端复核（2026-10-01）

[发布 v0.2.1](https://github.com/noteflowai/pai-design-workbench/releases/tag/v0.2.1)，运行源码 `f610fa1`，发布包 `571b6bd1…e6ba0a`。[该版本 CI](https://github.com/noteflowai/pai-design-workbench/actions/runs/36807659122) 三个作业全部通过，包括 39 组检查、14 个工业用例和六条浏览器流程。此版调整界面与运维超时，原生验收规则不变。

线上重新实际登录 Cognito，验证 1024/1280/1440px 下工作区宽度分别为 616/712/812px，助手位于工作区旁侧；820px 遮罩关闭、390px Esc 与关闭按钮、当前手机阶段自动滚动、无横向溢出、退出返回登录页均通过，页面错误为 0。跨源写入 403，未登录 STEP 下载 302。

部署期间发现外部维护者同时切换了相同源码的另一打包版本 `68ca9bb4…237e`，并新增一个任务。已保留该旧目录及观测记录，未重放任何原生任务。复核时 48 条文档中去除唯一新增任务后，原有 47 条逐行汇总 SHA-256 仍为 `93da681877a70ad4545bc467490af8e2d44a1f3edfaaf82e83705ad5480d7121`；SQLite integrity 为 ok，运行中任务为 0。此处验证的是 documents 表的逻辑记录，未宣称数据库物理字节或其他表不变。四份原 STEP 下载摘要与关闭反馈均保留。

基础设施 UPDATE_COMPLETE，目标健康，同 WordPress VPC 和 ALB，100/110/120/default 四条路由摘要全部不变，WordPress 公网 200，40GiB 持久卷加密，备份保留 14 天；恢复演练仍未完成。独立参与者仍为 0，模型提案未配置。

回执：[CAD 与反馈](evidence/deployment-cad-v021.json)、[逐记录持久化](evidence/deployment-persistence-v021.json)、[响应式布局与认证](evidence/deployment-ui-v021.json)、[共享基础设施](evidence/deployment-infra-v021.json)。截图：[线上桌面](evidence/cloud-v021-desktop.png)、[线上手机](evidence/cloud-v021-mobile.png)。

## 0.3.0 版本、发布与成熟度（2026-10-01）

对照 Onshape、Fusion、SOLIDWORKS/3DEXPERIENCE、NX/Teamcenter、CATIA、Creo、Blender 的官方界面资料（见[对比](UI_UX_BENCHMARK.md)），补齐四项专业工具共有、此前缺失的模式：需求版本快照与逐项比较、发布候选与成熟度关卡、同类候选并排检查矩阵、底部状态栏与成熟度标签。

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 40 组通过；新增发布关卡测试：拒绝的检查不可发布、失败案例未关闭时阻止、未关闭反馈时阻止、关闭后可创建、只允许一个待审批、比较-交换审批、第二次发布使第一次废止、需求修订使发布废止、版本快照与摘要、旧版本检查不可再发布、额外字段 400 |
| `npm run test:browser` | 7 组通过；新增发布流程：真实 CAD 失败 → 反馈复测 → 准入显示 2 项未通过且按钮禁用 → 关闭反馈 → 5 项通过 → 创建 R1 → 批准 → 候选对比矩阵 → 修订需求 v2，差异显示 50% → 70%，R1 变为已废止；390px 无横向溢出 |
| `test:native` / `test:blender` / `test:cad` / `test:suite` | 全部通过；14 个工业用例与预期一致 |
| 界面复查 | 1440/1280/1024/768/390 px 逐页无溢出、裁切、遮挡或过小控件 |

线上验收（发布包 `3709ae89…02d9`，[CI](https://github.com/noteflowai/pai-design-workbench/actions/runs/36816402095) 三个作业通过）：Cognito 登录后实际执行 CAD 失败 → 反馈 → 复测；关闭反馈前准入 2 项未通过、按钮禁用，关闭后 5 项通过；创建并批准 R1，审批人记录为 Cognito 身份；候选对比矩阵显示 1 项失败；修订需求为 v2 后 R1 自动变为已废止。跨源审批请求 403，未登录访问版本历史重定向到登录，已有反馈与 CAD 文件摘要不变，390 px 无横向溢出，控制台无错误。WordPress 路由 100/110/default 不变、公网 200、目标健康。回执：[线上流程](evidence/deployment-result-v030.json)、[基础设施](evidence/deployment-infra-v030.json)；截图：[发布](evidence/cloud-v030-release.png)、[对比](evidence/cloud-v030-compare.png)、[手机](evidence/cloud-v030-mobile.png)。本轮新增 2 个维护者验收任务（第一次验收在截图步骤超时，已批准的发布保留）；独立参与人数仍为 0。

截图：[发布](evidence/release-desktop.png)、[候选对比](evidence/release-compare.png)、[手机](evidence/release-mobile.png)。

## 0.2.2 界面复查发布（2026-10-01）

提交 `c1d790b`，[CI](https://github.com/noteflowai/pai-design-workbench/actions/runs/36810805958) 三个作业通过（LTS 作业含 CadQuery、14 个工业用例和 6 组浏览器流程），发布包 `27628f77…e3ed` 经 CDK（仅更新发布包读取授权）和 SSM 原子切换上线，上一发布目录保留。

线上实际执行（Cognito 登录后）：
- 在 CAD 设计通道选择“紧凑化”并提交，原生 B-Rep 几何在 3.2 s 出现在实时视口，18 s 完成；结论为拒绝，只有孔边距失败；STEP 下载摘要与记录一致。
- 助手停靠时在 1024 / 1280 / 1440 px 下，工作区宽 616 / 712 / 812 px，均位于助手左侧，无遮挡、无横向溢出。390 px 下助手默认关闭，作为全屏弹出层打开和关闭；反馈页直接列出尚未记录反馈的孔边距失败案例。
- 跨源写入 403；未登录下载 STEP 重定向到登录；已有反馈状态与 CAD 文件摘要不变；退出登录返回登录页；控制台无错误。
- 基础设施：WordPress 路由 100/110/default 不变，WordPress 公网 200，目标健康。

回执：[线上功能与布局](evidence/deployment-result-v022.json)、[基础设施](evidence/deployment-infra-v022.json)；截图：[CAD 1280 px](evidence/cloud-v022-cad.png)、[手机](evidence/cloud-v022-mobile.png)。本轮新增 2 个维护者验收任务和 2 次 CAD 检查（首次验收脚本在关闭手机弹出层的步骤出错后重跑）；独立参与人数仍为 0。

## 0.2.0 发布与云端复核（2026-10-01）

[发布 v0.2.0](https://github.com/noteflowai/pai-design-workbench/releases/tag/v0.2.0)，提交 `5d37dab`，发布包 `a217550d…b1daf`。[最终发布 PR CI](https://github.com/noteflowai/pai-design-workbench/actions/runs/36806224444) 的 LTS、Current 与基础设施三个作业全部通过；隔离副本也用 Node 24.21.0 完成 39 组检查、真实 Blender/CAD、14 个工业用例和六条浏览器流程。

线上同功能源码版本实际执行 CAD：轻量化候选仅 min-wall 失败；恢复基准参数、保持需求摘要不变后通过，反馈关闭；原生 B-Rep 实时阶段、工程视图、STEP 下载、390px 布局与控制台检查通过。随后 0.2.0 元数据版本原子切换，47 条文档记录的逐行汇总摘要完全一致，SQLite integrity 为 ok，四份 STEP 摘要与关闭反馈保留。未自动重放任务，旧发布目录仍保留。

切换后重新验证 Cognito/ALB 认证、原记录与 STEP 文件、390px 无横向溢出、跨源写入 403、未登录 STEP 下载重定向及退出返回登录页。WordPress 公网 200；同 VPC/ALB；四条 ALB 路由（100、110、120、default）摘要均不变；目标健康；持久卷加密、备份保留 14 天。快照恢复仍未演练。

回执：[CAD 文件与反馈](evidence/deployment-cad-v020.json)、[47 条记录持久化](evidence/deployment-persistence-v020.json)、[手机与认证边界](evidence/deployment-ui-v020.json)、[共享基础设施](evidence/deployment-infra-v020.json)。[线上手机截图](evidence/cloud-v020-mobile.png)。本轮新增一个维护者任务、两个 CAD 检查和一条关闭反馈；独立参与人数仍为 0，模型提案未配置，没有新策略推理或物理验证。

## AI 工作室、实时视口与工厂孪生（2026-09-30 第二轮）

本地 Node 22.23.3（CI 另用 24.21 LTS 与 26.10 Current）、Blender 5.2.2 LTS、Chromium（SwiftShader WebGL）实际运行：

| 检查 | 实际结果 |
|---|---|
| `npm run check` | 类型检查、33 组单元/接口测试、生产构建通过 |
| 新增单元测试 | 工厂孪生 9 组（逐字节样本、真实面板拒绝并保留 seed 3/11/10、放宽标准新建版本、能耗不抵消、篡改/伪造摘要/重复种子/影子执行均拒绝、标准须先冻结、身份幂等、反馈复测）；AI 工作室与实时流 7 组（计划 schema、放宽标记、依赖链、未配置不调模型、事件有界、SSE/主机校验/阶段摘要篡改、关闭时结束流） |
| `npm run test:native` | 原记录闭环通过，结果不变 |
| `npm run test:blender` | 真实 Blender 输出阶段 GLB：基准 3、候选 4；原生射线基准命中 Target、候选命中 Visibility obstruction；Cycles 采样 12/12 两次；SSE 回放 7 个阶段、2 条射线；阶段摘要逐一校验。见[回执](evidence/blender-e2e.json) |
| `npm run test:browser` | 5 组通过：原有 3 组；AI 对话生成计划→确认→真实 Blender 构建期间视口出现几何、LIVE 标识、射线遮挡、采样进度，阶段时间轴与基准切换，计划确认记为“与计划一致”；工厂对话→未冻结时拒绝执行评估→冻结→12 行逐种子表 3 处失败→seed 10 反馈以“保留并说明”关闭；Ctrl+K；均在 390px 无横向溢出且无控制台错误 |

截图：[AI 工作室](evidence/studio-desktop.png)、[手机](evidence/studio-mobile.png)、[工厂评审](evidence/factory-desktop.png)。实时事件仅用于展示；结论仍以保存的记录、回执与摘要为准。未执行新的策略推理、工厂孪生重跑或模型调用。

## 线上发布验收（AI 工作室版本）

提交 `4972bb4` 经 [GitHub Actions](https://github.com/noteflowai/pai-design-workbench/actions/runs/36784998513) 三个作业全部通过（LTS 作业含原生、Blender 与 5 组浏览器检查），发布包 `0770c334…b463` 经 CDK（仅更新 S3 读取授权与输出）和受控 SSM 原子切换上线，旧版本保留。实际 Cognito 登录后在 `https://pai.oneai.host`：

- 对话生成计划（确定性解析、无模型调用、权限无）→ 确认 → 主机上的 Blender 5.2.2 原生构建；视口从空开始，经共享 ALB 的 SSE 在 1.9 s 出现基准几何，9.7 s 出现候选遮挡物与被阻挡射线，约 20 s 完成；阶段 3/4、Cycles 12/12，阶段 GLB 摘要复核；计划确认记为“与计划一致”。
- 工厂评审：先冻结标准再评估，12 个种子中 seed 3、11 产出、seed 10 EV 服务失败，结论拒绝；seeds.json 摘要与复核记录一致。
- 跨源写入 403；未登录访问实时流与阶段文件被重定向到登录；既有任务与反馈状态不变；390px 无横向溢出，退出登录返回登录页，控制台无错误。
- 基础设施：WordPress 路由 100/110/default 逐项不变，WordPress 公网 200，同一 VPC 与 ALB，目标健康，仅 ALB 可访问 4317。

回执：[线上功能](evidence/deployment-result-v2.json)、[基础设施](evidence/deployment-infra.json)；截图：[桌面](evidence/cloud-studio.png)、[手机](evidence/cloud-studio-mobile.png)、[工厂](evidence/cloud-factory.png)。线上验收创建了维护者任务与检查记录，独立参与人数仍为 0；未执行新的策略推理、工厂孪生重跑或模型调用。

发布过程中发现并修复两处问题：新任务的视口保留上一场景几何（会使实时计时失真），以及视口逐帧渲染导致软件 WebGL 下页面卡顿；改为无场景时清空、按需渲染后重新通过全部检查。

## 云端复核

[GitHub Actions 实际运行](https://github.com/noteflowai/pai-design-workbench/actions/runs/36723476548)已成功，线上运行代码为 `1c0ae61dec98c8902eaaa7c24995e9ef2f27b75e`，包含 AWS 登录、长任务轮询与手机退出按钮修复。后续运维助手提交修正 SSM 的 Bash 解释器，不改变线上业务代码。

| 运行环境 | 通过的检查 |
|---|---|
| Node 24.21.0 LTS / Python 3.14 | 锁定依赖安装、类型检查、17 组边界测试、生产构建、原生记录及反馈闭环、独立证据交接、Blender 原生生成与文件重开、2 组原生浏览器端到端及 1 组登录态手机布局检查 |
| Node 26.10.0 Current / Python 3.14 | 锁定依赖安装、类型检查、17 组边界测试、生产构建、原生记录及反馈闭环、独立证据交接 |
| 基础设施作业 / Node 24.21.0 | CDK 锁定依赖、类型检查、启动脚本语法检查 |

Blender 和浏览器检查只在 LTS 作业中执行；Current 作业跳过这两项。Blender 使用其随发行版提供的 Python。CI 没有连接私人 NoteFlow 控制器或模型预算账本。

云端下载回执：

- [工作流与逐步骤结果](evidence/ci-result.json)
- [云端原生记录闭环](evidence/ci-native-e2e.json)
- [云端 Blender 与文件重开](evidence/ci-blender-e2e.json)
- [后续运维助手修复的 CI](evidence/ci-operator-result.json)（运行提交 `bcf9366`，三个作业均通过）

## 已验收的行为

| 检查 | 实际结果 |
|---|---|
| 严格类型检查、生产构建 | 通过 |
| 领域与接口边界测试 | 17 组：幂等、重启、源变化、假通过、反馈未修复/过期、保留失败的处理决定、证据包篡改、跨源写入、活跃所有者锁、未知模型效果不可换 ID 绕过、伪造登录、健康边界、退出登录及原生任务轮询等 |
| 原生历史策略记录闭环 | Robot Reel + 最新 EvalArc；相机 7/10 但丢失 1 个基准成功样本，拒绝；基准回退后复测关闭 |
| 独立证据交接 | 8 文件完整性与语义核验；临时目录重新执行 EvalArc，结果一致 |
| 原生 Blender 闭环 | 真实生成 `.blend`、GLB、PNG、原生几何检查；遮挡拒绝、未修复不能关闭、移除遮挡重新生成与复测后关闭 |
| `.blend` 文件重开 | 独立原生脚本重新打开保存文件；METRIC、占地 12m²、首个射线命中遮挡物，与原生检查一致 |
| 浏览器工作流 | 2 组原生端到端通过；真实视频解码和播放、Blender 图片解码、界面反馈关闭、下载与交付核验；另有 1 组纯 UI 登录态布局检查，不生成实验或用户记录 |
| 多端基础 | 390px 无横向溢出；PWA 清单、应用壳缓存；私人 API 不进缓存 |

机器可读的脱敏摘要：

- [原生记录闭环](evidence/native-e2e.json)
- [原生 Blender 与文件重开](evidence/blender-e2e.json)

完整私人记录、原生文件和交付包保存在本仓库 `.state`，不提交到 Git。工作台已验证的依赖固定为 Robot Reel `6124cee3cba5`、EvalArc `6af26bf0184d`、Radar `c7cd75d3cca6`。原生生成的 Blender 软件版本为 5.2.2 LTS。Robot Reel 后续新增的 Factory Twin 已在独立副本复验，见[接入评估](ROBOT_REEL_INTEGRATION.md)，尚未替换线上工具版本。

## 真实部署验收

[https://pai.oneai.host](https://pai.oneai.host) 已在 WordPress 的 VPC 与同一个 ALB 上部署。实际 Cognito 登录、ALB 签名身份验证、两个原生工作流、390px 布局、手机退出登录与跨源写入拒绝均通过。更新前后的两轮维护者端到端共保留 4 个任务、8 条完成的原生检查和 4 条关闭的反馈，独立参与人数仍为 0。

- [线上浏览器与原生闭环](evidence/deployment-result.json)
- [现有 ALB 路由、WordPress、持久卷与备份配置](evidence/deployment-infra.json)
- [服务重启、SQLite 完整性、逐记录一致性及原生文件摘要](evidence/deployment-persistence.json)
- [桌面截图](evidence/cloud-desktop.png)与[手机截图](evidence/cloud-mobile.png)

已验证服务重启后的持久化；AWS Backup 快照恢复尚未演练。单实例与单管理工作区的限制见[部署文档](DEPLOYMENT.md)。

本工作区的 `http://127.0.0.1:4317` 已加载两个完成的维护者场景：记录评审和 Blender 静态场景。它们保留原始任务、请求身份和原生回执；导入已完成场景没有新增推理、仿真或用户活动。两个反馈均已关闭，独立试用人数仍为 0。运行状态和来源说明保存在被忽略的 `.state/demo-origin.json`；新 checkout 不包含这些私人状态。

浏览器端到端实际发现过反馈更新误用 POST，已修为 PATCH 并重新验收。修复与所有失败记录可追溯，未把错误操作计为成功。

仍未完成：新的策略推理、动力学/关节可达性/现场验证、通用机械设计与工艺验证、独立用户试用、用户间工作区隔离、桌面/移动原生壳。NEMA 17 参数化零件及名义 DFM 规则检查已在上方记录。AWS 单管理工作区的远程认证已实现。模型控制接口已实现；预算账本未配置，未执行真实模型提案。没有发送邀请或自动发布案例推广内容。

证据包完整性不等于第三方来源认证；原始视频仍需要原 Robot Reel 数据包及其 NOTICE。合成 Blender 场景不代表测量得到的工厂孪生。


## 原生 CAD 包围盒与线上边界验收（2026-10-01）

显示网格影响默认 CadQuery 包围盒：对同一保存的 STEP，内存网格化使尺寸从 60×30×50 mm 变为约 60.0000002×30.0034969×50.0008549 mm，体积未变。OCCT `AddOptimal` 显式禁用已有网格与形体容差扩张后，几何包络保持 60×30×50 mm；这仍是名义几何计算，未验证制造公差。

[修正 PR #3](https://github.com/noteflowai/pai-design-workbench/pull/3)加入精确尺寸、STEP 重导入包络一致及精确要求边界的原生检查。[完整 CI](https://github.com/noteflowai/pai-design-workbench/actions/runs/36830499113)通过双 Node 版本、历史记录、Blender、CadQuery、工业用例及桌面／手机／视频工作流。合并提交 `858d7c9` 与测试分支文件树相同。

线上已验证：原有 67 条记录与 18 份 STEP 在切换后逐项不变；同一 VPC、ALB、实例与持久卷保持不变；四条路由摘要相同，WordPress 200，匿名入口仍要求 Cognito。已登录的维护者新增一条精确包络 CAD 验收，7 项原生检查通过，下载 STEP 的哈希与回执匹配。1280px 桌面与 390px 手机没有横向溢出，JavaScript 错误为零。

[脱敏验收摘要](evidence/cad-bounds-cloud-acceptance.json)不包含私人记录、凭据或浏览器会话。完整回执和截图保留本地。该例是维护者验收，独立参与人数仍为 0；没有新增模型生成、现场验证或 FEA。
