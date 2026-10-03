# 实际验证记录

2026-09-30，最新 Node 24.21.0 LTS、TypeScript 7.0.2、Blender 5.2.2 LTS。

## 签名发布与引擎升级（2026-10-03）

| 检查 | 实际结果 |
|---|---|
| 引擎 | 执行器 `95215e6`（[PR #53](https://github.com/noteflowai/noteflow-agent-control/pull/53)）：Kiro CLI 2.27.1、acpx 0.19.4、Codex ACP 2.1.1、Claude ACP 0.85.1。各版本只在一处登记，执行器 176 个单元测试和 20 个 acpx 流程测试全部通过。托管站点的安装器报告 `kiro-cli-chat 2.27.1` |
| pai.oneai.host（release `0d2de0a1…34ad5`）完整闭环 | MuJoCo 发现 75 % 速度下撞围栏，结论拒绝 → Kiro 主账号 2.27.1（claude-opus-5.5）引用 scene-1 和 version-1，把围栏退回 0.30 m，没有放宽任何要求 → 按原计划执行，复测 4 项全部通过 → 反馈用绑定的复测记录关闭 → 准入 5 项全部通过 → 批准发布 R1 |
| 签名发布包 | 包含 8 个原生文件（MJCF、逐种子结果、GLB、检查结果）。清单由 KMS 密钥（ECDSA P-256）签名，固定公钥后核验为可信；改动发布标题后检测到“Manifest digest mismatch” |
| 本地 | `npm run test:package`：12 个文件，篡改后返回 PACKAGE_FILE |
| 基础设施 | ALB 规则 100/110/默认未变；WordPress 200；目标健康 |

见 [回执](evidence/deployment-signing.json)。

## 物理层与 Agent 集成（2026-10-03）

| 检查 | 实际结果 |
|---|---|
| 云端 CI（run 37104007842，`6186f4a`） | 全部通过。工业用例 27/27，含 Y1（FEA）与 K1（MuJoCo）；浏览器 17 组；`test:fea`、`test:robot`、`test:optimize` |
| 结构 FEA | t = 3 mm 支架：几何 7 项全过，CalculiX 实测挠度 0.095 mm > 0.06 mm，结论拒绝；两级网格挠度差 1.85 % |
| MuJoCo 工作单元 | 速度 75 %、围栏内收到 0.12 m：每个种子都碰围栏，拒绝；围栏退回 0.30 m 后 10/10 通过，节拍 4.60 s，比参考快 22 % |
| pai.oneai.host（release `3818cc2f…ae12`）真实 AI | Kiro 主账号（claude-opus-5.5，48 s）根据 cad-1 给出 `cad-optimize` 计划，含 3 个带物理估算的种子，没有放宽任何要求。按原计划执行 17 个点，7 个可行。最轻的是 AI 种子 t 4、W 57（45.9 g，0.046 mm）。AI 挠度估算误差 10–19 %；代理模型在最后 6 个点的平均相对误差约 1.3 % |
| Agent API | ALB `jwt-validation` 规则 119：无令牌和伪造令牌都返回 401；只有 read scope 的令牌不能提议计划（401）；未列出的路由返回 404。提议计划带已验证的客户端 id 和会话 id，权限为无。pai-mcp 用客户端凭据经 HTTPS 正常读取工作区 |
| 基础设施 | ALB 规则 100/110/默认未变；WordPress 200；目标健康 |

见 [回执](evidence/deployment-physics.json) 和 [PHYSICS.md](PHYSICS.md)。

## 工厂产线布局：Blender + AI（2026-10-03）

| 检查 | 实际结果 |
|---|---|
| `npm run test:plant` | 6 工位 CNC 产线，围栏 4.2 m：原生实测通道净宽 2.08 m，结论拒绝，EvalArc 报 1 项回归。记录反馈后，把设计通道加宽到 2.8 m：实测净宽 2.48 m、占地 641.6 m²，复测通过，反馈关闭。场景有 181 个原生对象，最终 GLB 带动画 |
| `npm run test:suite` | **27 个用例**（开启 A3、X1）。完整运行 26/27：X1 因本机实例角色缺少 `InvokeAgentRuntime` 权限返回 403。改用受限运维角色单独重跑 X1，通过；两次结果都保留在[回执](evidence/industrial-suite.json)。新增 P1（拒绝；净宽 2.08 m）和 P2（通过；2.48 m、641.6 m²）|
| 浏览器 | 新增“工厂产线”一组：表单 → 8 个阶段流式进入视口 → 拒绝 → 实测表 → 6/6 相机射线 → 播放动画 → Cycles 渲染图 → “问 AI”生成 `plant-layout` 计划（使用脚本执行器）→ 在专业面板调整；390 px 无溢出 |
| 单元测试 | 64 组通过（新增 plant 契约、派生厂房尺寸、修正后失败案例仍保留、规则解析器 plant 计划）|

| 云端 CI（[run 37076297416](https://github.com/noteflowai/pai-design-workbench/actions/runs/37076297416)，`0d35427`） | 仓库改为公开后恢复运行：Node 24.21 / 26.10 两个作业和 CDK 检查全部通过；工业用例 25/25（含 P1、P2），浏览器 16 组通过。桌面三平台打包（run 37059789103）也通过 |
| pai.oneai.host（release `5dff2b8e…6e3d`） | 登录后经 HTTPS API 运行：6 工位候选拒绝（净宽 2.08 m，6/6 相机，1 项回归，145 s）；通道 2.8 m 通过（2.48 m、641.6 m²，145 s）。界面显示实测表、8 个阶段、40 段动画、3 张 Cycles 渲染图；390 px 无溢出，无页面错误。ALB 规则 100/110/默认未变，WordPress 200，目标健康。见 [回执](evidence/deployment-plant.json) |

范围：合成配方，几何规则使用经验值；不含动力学、节拍、照度、安全认证和现场测量。见 [PLANT.md](PLANT.md)。

## 0.8.0 界面、易用性与桌面端（2026-10-02）

| 检查 | 实际结果 |
|---|---|
| 无障碍（`tests/browser/usability.spec.ts`） | axe-core 4.13 按 WCAG 2.1 A/AA 扫描 40 个页面（10 个视图 × 浅色/深色 × 1440/390 px）：严重和关键问题 **0**；390 px 下全部无横向溢出 |
| 键盘操作 | 第一次按 Tab 落在“跳到主要内容”，且焦点框可见；Ctrl+K 输入“CAD 零件”后回车，约 1.9 s 进入 CAD 通道；在命令框输入的不是命令时，出现“问 AI”选项，回车后填入助手输入框并获得焦点；`[` 收起侧栏（≤ 64 px），刷新后保持；主题按浅色 → 深色 → 跟随系统切换，刷新后保持 |
| 典型用例 C2 + AI | 共 6 次点击：创建任务 → 轻量化 → 原生拒绝（37 s）→ 在“最小壁厚”行点“问 AI”（输入框自动带上实测值 2.5 和要求 ≥ 3，自动切到 AI 引擎）→ 回答引用 cad-1 → 确认计划 → 复测通过（共 75 s）。助手停靠时，视口顶部在 367 px、高度 522 px |
| 典型用例 G1 与 S1 | 生成代码：选择、改一行、运行，38 s 得到最小壁厚不合格；3 点扫描 21 s 完成，默认选中最轻的可行点；390 px 无溢出 |
| 回归 | 浏览器 15 组通过（新增易用性 4 组）；单元测试 58 组通过 |
| 桌面端（`npm run test:desktop`） | linux-unpacked 和 AppImage 各跑一次：Electron 44.5.1 / Node 24.21.0；安全设置全部生效；5 个原生菜单齐全；典型用例 C2 通过界面得到最小壁厚不合格；关闭应用后服务端口不再响应；首次安装路径检查通过（没有工具时提供安装按钮）。安装包：AppImage 211 MB，deb 166 MB（依赖 python3、bubblewrap）。见[回执](evidence/desktop-e2e.json)和[截图](evidence/desktop-c2.png) |
| 修复的问题 | 表格里的 `.visually-hidden` 是绝对定位，跳出了滚动容器，把手机页面撑宽到 637 px；网格子元素不能缩小到内容宽度以下；浅色主题的三级文字对比度只有 3.6:1；深色主题主按钮和用户气泡的对比度不足。以上均已修复，并由测试覆盖 |

| CI 桌面打包（`Desktop packages`，run 36953877489） | Linux（AppImage + deb）、Windows（nsis）、macOS（dmg，arm64）三个平台都打包成功；Linux 上对打包后的应用做了冒烟测试，结果 passed，关闭后服务端口不再响应 |
| pai.oneai.host（release `4f9d694d…11fe`） | 登录后，axe 扫描 30 个页面（10 个视图 × 浅色/深色 1440 px、深色 390 px）：严重和关键问题 0，无溢出；CAD 实测表格中只有“最小壁厚”一行未通过（2.5 mm，要求 ≥ 3，余量 -17%）；点“问 AI”后输入框带上问题并获得焦点；Ctrl+K 可跳转到 CAD 通道；控制台无错误；WordPress 返回 200，ALB 规则未改。见[回执](evidence/deployment-v080.json)和[截图](evidence/cloud-ui-dark.png) |

表中的原生桌面回执来自 Linux。跨平台 CI 的当前验收规则见 [DESKTOP.md](DESKTOP.md)：PR/main 运行三平台路径、提交和失败保留检查；手动/tag 构建还分别启动三平台打包程序，验证隔离、平台能力与退出，并保存结果或失败证据。Windows/macOS 启动 smoke 不等于已经通过原生 C2，自动安装目前仅支持 Linux x64。

截图：[深色验证工作区](evidence/ui-dark-validate.png)、[浅色 + AI 助手](evidence/ui-light-validate-assistant.png)、[深色手机](evidence/ui-dark-mobile.png)。

## 0.7.0 工业设计典型用例全量端到端（2026-10-02）

| 检查 | 实际结果 |
|---|---|
| `npm run test:suite` | **25/25 通过**（开启 A3、X1）。覆盖：机器人感知 R1–R2，Blender 布局 B1–B3，CAD 零件 C1–C5，工厂孪生 F1–F3，AI 助手 A1–A3（A3 为真实 Kiro 调用），生成代码沙箱 G1–G4，设计空间 S1–S2，从失败到发布、需求修订的完整闭环 L1，MCP 外部 Agent M1，AgentCore arm64 云端沙箱 X1。见[回执](evidence/industrial-suite.json)和[用例说明](INDUSTRIAL_TEST_CASES.md) |
| 其余端到端 | `test:native`、`test:blender`、`test:cad`、`test:cad-code`、`test:cad-sweep` 全部通过；浏览器 11 组通过；单元测试 58 组通过；AgentCore 入口契约测试通过 |
| pai.oneai.host（release `3fba9d85…df02`） | 通过 Cognito 登录后经 HTTPS API 跑 9 个典型用例，全部通过：R1 相机外参、B1 Blender 遮挡、C2 轻量化、C3 止口孔、F1 工厂孪生、G1 沙箱生成代码、G3 越权代码、S1 8 点扫描（最轻 t=3、37.356 g）、S2 扫描点转为候选。长任务首个响应为 202，浏览器轮询状态地址；390 px 无溢出，控制台无错误；WordPress 返回 200，ALB 原有规则未改。见[回执](evidence/deployment-v070.json)和[基础设施](evidence/deployment-infra-v070.json) |
| 新增功能 | MCP 新增工具 `pai_check_cad_code`（只做静态策略检查，不执行），对应 [AI_CAD_LANDSCAPE.md](AI_CAD_LANDSCAPE.md) 中列出的差距；5 项差距已全部补齐 |

## Amazon Bedrock AgentCore（arm64 自带容器，2026-10-02）

| 检查 | 实际结果 |
|---|---|
| 构建 | CodeBuild 在 arm64 上原生构建两个镜像：沙箱镜像压缩后 0.42 GB；执行器镜像压缩后 0.55 GB，解压后 1.34 GB。都在 AgentCore 2 GB 上限以内。精简 CadQuery 锁的全部原生路径结果与完整锁逐值相同 |
| 沙箱探测（真实 microVM） | aarch64；无法访问互联网；bubblewrap 可以启用；uid 1001；运行时没有凭据 |
| 沙箱任务 | 模板 = 预设 reference（48.368 g）；2.5 mm 板厚判为 min-wall 失败（31.85 g）；`import socket` 在执行前被拒绝；死循环 60 s 后以 limit 结束；同一会话再次提交返回 409。质量和实测值与 amd64 相同 |
| 执行 Agent | Kiro 2.24.0 aarch64、执行器 ec007f0；EFS 账本只创建一次，第二次 init 不替换；在新会话中重放同一 run_id 返回已保存的答案，额度不变；运行时版本从 28b7da0b 更新到 9dbf763b 后，已完成的尝试仍是 1 |
| 工作台联调 | 本机没有执行器和密钥：AI 请求经 AgentCore 由 Kiro 主账号完成，生成 1 个 cad-code 计划；确认后该代码在 AgentCore 沙箱中建模并通过全部检查；远端沙箱运行的回执为 agentcore-cad-sandbox，EvalArc 对照在本地完成 |
| `npm test` | 新增 AgentCore 模拟器测试：远端报告经过同一套校验，只开放 Kiro；超时、影响未知和 5xx 都进入待核对，且只调用一次；会话 ID 至少 33 位；只有探测结果为 microVM 且无互联网时才启用远端沙箱。服务端 SigV4 签名与 botocore 逐字节一致 |
| 日志 | 只有路径和状态码；没有请求体、代码、提示或密钥 |

见 [回执](evidence/agentcore.json) 和 [联调](evidence/agentcore-live.json)。共消耗 1 次真实尝试。

## 0.6.0 设计空间扫描与线上验收（2026-10-01）

线上（pai.oneai.host，release `11e6f040…48ed2`）：24 个点的扫描在主机上用时 48 s，首个响应为 202，浏览器轮询状态地址拿到结果。满足全部检查的点有 3 个，最轻的是 t=3、W=60、H=46（37.36 g）。由该点生成的正式候选结论为通过，EvalArc 没有阻断项，质量与扫描点一致。390 px 无溢出，控制台无错误，WordPress 不变。见[回执](evidence/deployment-v060.json)、[基础设施](evidence/deployment-infra-v060.json)和[截图](evidence/cloud-sweep.png)。

第一次线上验收发现：扫描本身 45 s 就完成了，但界面一直停在“运行中”。原因是浏览器只跟随一份白名单内的 202 状态地址，而 `/api/cad-sweeps` 不在其中。本地测试不返回 202，所以没有暴露。已修复，并新增单元测试，断言服务器上每个返回 202 的路由都在浏览器的跟随白名单里；临时删掉白名单条目后该测试确实失败。

| 检查 | 实际结果 |
|---|---|
| 配方重构 | 4 个预设的检查结果与重构前逐值相同 |
| 24 点原生扫描（本机） | 2 分 20 秒，平均每点约 5.5 s。满足全部 7 项检查的点有 3 个：板厚 3/3.5/4 mm、宽度 60、高度 46；其余点因孔边距或壁厚失败。最轻的可行点是 t=3 mm，37.36 g，比基准 48.37 g 轻约 23% |
| `npm run test:cad-sweep` | 12 点扫描中，与 reference、lightweight、compact 参数相同的点和对应预设逐项一致（检查结果、实测值、质量）。最轻可行点为 t=3、W=60、H=46，位于帕累托前沿。把该点生成正式候选后结论为通过，EvalArc 没有阻断项，实测值与扫描点相同。伪造来源（参数与扫描点不一致）返回 422，超过 36 个点或超出边界的网格返回 400。见[回执](evidence/cad-sweep-e2e.json) |
| `npm test` | 54 组通过。新增：帕累托前沿只包含可行点；网格按轴和总数设上限（恰好 36 个点允许，54 个点拒绝）；只有 parametric 变体接受参数与来源；AI 的 `cad-sweep` 计划按同一网格边界校验，越界计划被拒绝，规划阶段不运行扫描 |
| `npm run test:browser` | 11 组通过。新增：3 点扫描显示散点图；默认选中最轻的可行点；可用键盘选择点；由点生成正式候选后结论为通过，候选记录了来源；重新打开页面时输入框与显示的扫描一致；390 px 无溢出 |

## 0.5.0 发布与线上验收（2026-10-01）

| 检查 | 实际结果 |
|---|---|
| pai.oneai.host 生成代码通道 | 能力清单显示沙箱可用（10 项隔离）；编辑器策略检查列出 `import subprocess` 违规；2.5 mm 板厚代码在沙箱中建模 16 s，原生检查判 min-wall 失败（实测 2.5），回执依次为 cadquery-native → cadquery-sandbox → cadquery-sandbox-check → evalarc-native；跨源写入返回 403 |
| 线上真实 Kiro 写代码 | Kiro 主账号（claude-opus-5.5）用时 29 s 返回 1 个 `cad-code` 计划（31 行代码，无越权），确认后在沙箱中建模，原生检查全部通过（min-wall 实测 3.5）。共用 1 次真实尝试，没有重放。见[回执](evidence/deployment-v050.json)和[截图](evidence/cloud-ai-code.png) |

线上截图暴露了一个生命周期缺陷：生成代码零件的身份只按变体和需求计算，因此 AI 写出的通过版本把另一份代码的失败案例“覆盖”掉了，显示为 0 个失败案例。现在候选身份包含代码摘要，失败案例会一直保留，直到通过反馈复测关闭；已加入回归测试。另外，确认未核对的 AI 计划时，原来要等原生任务跑完、记录确认时才被拒绝；现在新增 preflight 检查，在启动任何原生工具之前就拒绝，浏览器测试断言此时不会产生新的检查记录。

## 生成代码通道（2026-10-01）

| 检查 | 实际结果 |
|---|---|
| 共用检查重构 | 4 个预设变体的检查结果与重构前逐值相同（质量、体积、包围盒、每项检查的实测值和孔列表）；新增的同轴偏差、安装面位置字段对 4 个预设均为 0 |
| `npm test` | 50 组通过。新增：静态策略拒绝 22 类违规，模板通过；只有 generated 接受代码；沙箱参数先隐藏、后挂回，只有输出目录可写；AI 的 `cad-code` 计划在沙箱不可用时被拒绝，可用时同时提供模板和 schema，越权代码计划被丢弃，规划阶段不运行代码 |
| `npm run test:cad-code` | OS 层：读不到工作台状态，脚本目录只读，无网络，环境变量为空，主目录与 /run 不可见。进程层：写目录外文件、网络、子进程、`os.system`、ctypes 全部抛出 PermissionError。模板经沙箱建模后，7 项检查与预设 reference 逐项相同（约 30 s）。2.5 mm 板厚判为 min-wall 失败（实测 2.5），记录反馈后用 3.5 mm 代码复测通过，反馈关闭。策略违规与 `__globals__` 逃逸返回 422 且不产生记录；访问子模块与产生两个实体判为 error，超出内存判为 limit，死循环被 CPU 上限终止，都不产生证据。见[回执](evidence/cad-code-e2e.json) |
| `npm run test:browser` | 10 组通过。新增：编辑器内检查策略（列出违规，然后通过）、在沙箱中运行、得到原生失败、显示代码与沙箱结果、记录反馈后在编辑器中修订代码并复测；AI 计划展示生成的代码，越权计划被拒绝，确认后才执行；390 px 无溢出 |
| `npm run test:cad`、`npm run test:suite` | 通过，14/14 用例与预期一致 |
| 托管主机探测 | 在与服务相同的 systemd 加固下，Ubuntu 24.04 默认限制了用户命名空间，bubblewrap 失败；加载只针对 bwrap 的 AppArmor 配置后隔离成功，CadQuery 2.8.0 可以加载，网络与主目录均不可见 |
| Docker 镜像 | 通道禁用，返回 503 并说明原因，见 [CONTAINER.md](CONTAINER.md) |

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
