# PAI Design Workbench

TypeScript 专业设计工作台：**需求 → 候选设计 → 原生验证 → 失败回放 → 反馈复测 → 可核验交付与试用反馈**。

AWS 入口：[pai.oneai.host](https://pai.oneai.host)（管理员登录）。复用 WordPress 的同一 VPC、ALB 和 HTTPS 证书，见 [部署说明](docs/DEPLOYMENT.md)。

首个可运行场景是机器人实验设计评审。Radar 提供专业线索，领域适配器连接 Robot Reel 的真实记录核验与 EvalArc 的独立检查项对照，现有 NoteFlow 控制器保留模型预算、路由和恢复职责。

[![机器人工作单元提速：MuJoCo 发现碰撞、AI 修正、CalculiX 否决几何最优、物理寻优、KMS 签名发布](docs/media/physics-demo.gif)](docs/media/physics-demo.mp4)

**演示 A · 机器人工作单元提速，AI 设计、物理求解器裁决**：[docs/media/physics-demo.mp4](docs/media/physics-demo.mp4)（约 5.5 分钟，1280×800）。在 pai.oneai.host 上实时录制，也可以在 [GitHub Release](https://github.com/noteflowai/pai-design-workbench/releases/tag/demo-physics-2026-10-03) 下载。

1. 目标是节拍 ≤ 5 s（参考单元 5.9 s）。初版把关节速度提到 75 %、围栏内收到 0.12 m。MuJoCo 跑了 10 个种子：节拍 4.6 s 达标，但每个种子肘部都撞到围栏，EvalArc 判定候选丢失了基准通过的检查，结论为拒绝。
2. 在失败的检查上点“问 AI”。Kiro 2.27.1（claude-opus-5.5）引用 scene-1，把围栏退回 0.30 m，速度保持不变，没有放宽任何要求。复测 4 项全部通过：节拍 4.6 s，比参考单元快 22 %，10/10 个种子成功。失败案例通过绑定的复测关闭。
3. 电机支架冻结结构要求（60 N 皮带载荷、挠度 ≤ 0.06 mm）。只看几何时最轻的 t = 3 mm 能通过 7 项几何检查，但 CalculiX 实测挠度为 0.095 mm，被否决。
4. AI 按第一性原理提出 3 个种子并附上挠度估算。实测 19 个点，其中 7 个可行；最轻的可行点由代理模型的 exploit 步骤找到：t 3.67、W 60.05、H 49.53，46.9 g，挠度 0.058 mm。正式复核 9/9 通过。AI 的 3 个种子都略超限，求解器给它们打分，挠度估算偏低 10–14 %。
5. 两条反馈都已关闭，准入 5/5，R1 发布。在界面里核验签名：AWS KMS ECDSA P-256，20 个原生文件的摘要一致。

回执见 [physics-demo.json](docs/evidence/physics-demo.json)。

[![AI + Blender 设计工厂产线：原生生成、射线实测、AI 修正、复测通过](docs/media/factory-demo.gif)](docs/media/factory-demo.mp4)

**演示 B · AI + Blender 设计工厂产线**：[docs/media/factory-demo.mp4](docs/media/factory-demo.mp4)（约 5 分钟，1280×800），也可以在 [GitHub Release](https://github.com/noteflowai/pai-design-workbench/releases/tag/demo-factory-2026-10-03) 下载。

1. 用一句话描述 6 工位 CNC 机加工产线（围栏加大到 4.2 m、AGV 通道 2.4 m、厂房 ≤ 650 m²），解析成类型化计划。
2. Blender 5.2 按 8 个阶段生成整座车间，实时推送到三维视口：柱网桁架、输送线、CNC 加工中心、六轴机器人、安全围栏、货架、AGV、桥式起重机和检测相机，共 181 个对象，带 Cycles 渲染和动画。
3. BVH 射线实测发现耦合问题：加大的围栏挤占了通道，净宽只有 2.08 m（要求 ≥ 2.4 m），结论为拒绝。
4. 在失败的检查上点“问 AI”，真实调用 Kiro 主账号（claude-opus-5.5）。它在不放宽任何要求的前提下把通道加宽到 2.8 m。确认后重新生成：净宽 2.48 m，厂房 641.6 m²，5 项检查全部通过。

回执见 [factory-demo.json](docs/evidence/factory-demo.json)，通道说明见 [PLANT.md](docs/PLANT.md)。

![Blender Cycles 渲染：AI 修正后的 6 工位 CNC 产线](docs/media/factory-render.png)

**演示 C · 生成式 CAD**：

[![生成式工业设计演示：AI 写 CadQuery 代码，原生 B-Rep 检查给出结论](docs/media/demo.gif)](docs/media/demo.mp4)

完整视频：[docs/media/demo.mp4](docs/media/demo.mp4)（约 3 分钟，1280×800），也可以在 [GitHub Release](https://github.com/noteflowai/pai-design-workbench/releases/tag/demo-2026-10-02) 下载。

视频里的全部结果都是录制时实时产生的：
1. NEMA 17 支架轻量化，板厚 4 → 2.5 mm，被原生检查拒绝。
2. 在“最小壁厚”这一行点“问 AI”，真实调用 Kiro 主账号（claude-opus-5.5），由它写出 CadQuery 代码。
3. 代码在三层沙箱中建模，通过全部 7 项检查，39.6 g。
4. 16 点原生设计空间扫描，找到最轻的可行设计 t = 3 mm，37.4 g，作为正式候选也通过了检查。

三段成片都没有剪切或调换顺序，只把画面静止的等待片段加速播放。CAD 演示的回执见 [demo.json](docs/evidence/demo.json)。

实现了五条原生证据通道：**机器人历史记录评审**、**Blender 工作单元布局**、**Blender 工厂产线布局**、**CadQuery/OCCT 参数化 CAD 零件**、**工厂孪生维护与能源评审**。它们共用同一条生命周期闭环：需求冻结 → 候选设计 → 原生验证 → 失败回放 → 反馈复测 → 发布交付。需求版本只追加、可逐项比较；发布候选须通过准入检查（检查通过、绑定当前需求、失败案例均已关闭）并经维护者批准，需求修订后自动废止。底部状态栏显示原生任务、需求哈希与工具状态。左侧栏显示每个阶段的状态，总览页给出“下一步”，二者都由已保存的记录推导。

**AI 助手**停靠在右侧，把对话解析成类型化的工具计划，并标出每项约束是收紧还是放宽。计划没有验收权，只有你确认后才调用原生工具。Blender 和 CadQuery 每完成一个构建阶段，几何就通过 SSE 推送到 three.js 专业视口；视口支持轨道操作、视图预设、大纲、检查器、线框/X 光和阶段时间轴，另有 Ctrl+K 命令面板。界面为响应式 Web/PWA。[27 个典型工业设计测试用例](docs/INDUSTRIAL_TEST_CASES.md)覆盖全部通道。

**AI 引擎**通过受控执行器调用 Kiro（主账号 → 备用账号 → 二备账号），本机还可以使用 Codex 和 Claude。模型回复按同一套契约重新校验后成为计划或附引用的回答，引用必须指向已存记录。影响未核实的运行要先经人工核对，不会自动重试。pai.oneai.host 已启用 Kiro 三个账号。全部组件可装进一个固定版本的镜像，见 [CONTAINER.md](docs/CONTAINER.md)。外部 Agent 可通过本机 [MCP 服务器](docs/MCP.md) 读取记录并提议计划，同样需要人工确认。预设变体不够用时，AI 或维护者可以直接写 CadQuery 代码：代码在三层沙箱（AST 策略、进程锁定、无网络的 bubblewrap）中只产生实体，结论来自与预设相同的原生检查，见 [生成代码通道](docs/CAD_CODE.md)。沙箱和执行 Agent 也可以作为 arm64 自带容器运行在 Amazon Bedrock AgentCore 上：每个代码任务使用独立 microVM、没有网络路由，账本放在保留的 EFS 上，见 [AGENTCORE.md](docs/AGENTCORE.md)。CAD 通道还提供原生设计空间扫描：逐点建模实测、散点图和帕累托前沿，选中的点作为正式候选进入同一套检查与发布流程。

界面支持浅色和深色主题，顶栏的命令框可以搜索命令，也可以直接向 AI 提问；每个未通过的检查旁都有“问 AI”。CAD 检查结果以带余量条的实测表格展示。全部页面通过 WCAG 2.1 AA 自动检查。桌面版基于 Electron，提供 AppImage、deb，以及由 CI 构建的 Windows 和 macOS 安装包。Linux x64 支持一键安装原生工具；Windows/macOS 可手动选择已有工具，见 [DESKTOP.md](docs/DESKTOP.md)。

**物理层**：冻结结构要求后，CAD 评审会用 Gmsh 划分二次四面体网格，再用 CalculiX 计算电机轴挠度和峰值应力。基准件与候选件都要算，各用两级网格并给出收敛对照，结果同样经 EvalArc 对照、进入发布准入。

**物理寻优**：先实测参考件、AI 种子和 Sobol 点；再用高斯过程代理模型与 NSGA-II 排序候选，先做几何筛查，再交给 CalculiX 求解。代理模型只负责排序，推荐的是实测最轻的可行点，选中后还要经过正式复核。AI 提出种子时要附上自己的物理估算，系统用求解器结果给它打分。见 [PHYSICS.md](docs/PHYSICS.md)。

**CAD → 仿真 → 孪生**：已通过的 CAD 零件可以装到 MuJoCo 机械臂末端，质量和惯量取自已核验 STL 的精确体积，并与 B-Rep 质量交叉核对（差值 ≤ 3 %，否则失败）。每次仿真都导出可移植的 MJCF 和 OpenUSD（UsdPhysics 刚体、质量、转动/固定关节、碰撞体），后者经 OpenUSD 26.8 全部 28 个 UsdValidation 校验器检查，可直接导入 Isaac Sim / Omniverse。

**外部 Agent**：AgentForge 会话可以经治理网关使用工作台：按会话放行工具、审计、限流。托管站点用 OAuth 客户端凭据访问，ALB 先验证一次 JWT，工作台再按 scope 验证一次。见 [integrations/agentforge](integrations/agentforge/README.md)。

不执行新的策略推理，不做公差叠加、疲劳、现场安全认证或自动发布；FEA 是名义材料下的线性静力分析，不是认证。

## 快速启动

要求 Node.js ≥24.21（当前最新 LTS）、npm、Python ≥3.12、Git。

```bash
npm ci
npm run setup:demo    # 下载固定版本的公开工具及原始仿真记录，约45MB记录
npm run setup:native  # Linux x86_64：最新 Blender 5.2.2 LTS，官方校验和验证
npm run setup:cad     # Python 3.12：哈希锁定的 CadQuery 2.8.0 / OCCT 7.9
npm run check
npm run test:native
npm run test:blender
npm run test:cad
npm run test:plant   # 工厂产线：拒绝 → 反馈 → 修正复测 → 关闭
npm run setup:physics # Gmsh / CalculiX（签名 Ubuntu 源）/ Optuna / scikit-learn / MuJoCo
npm run test:fea      # 结构 FEA：t=3 mm 几何检查通过，但挠度超限
npm run test:optimize # 物理寻优：AI 种子 + 代理模型 + 正式复核
npm run test:suite   # 典型工业设计用例（默认 25 个）
npm run start        # http://127.0.0.1:4317
```

本工作区使用 `.state/deps` 内已验证的固定版本副本，避免跟随 Kiro 正在修改的相邻工作区。安装脚本只使用本仓库 `.state/deps`；如果既有依赖版本或工作区变化，停止并保留它们。

1. 创建任务，冻结最低成功率、保留基准和统计改善要求。
2. 选择相机偏移，执行原生检查，查看失败与配对统计。
3. 回放 seed 9：基准成功、相机失败。即使总成功数增加，也应拒绝不符合保留要求的方案。
4. 记录反馈，依次复现、分配、提出回退、回退基准并复测、关闭。
5. 下载证据包；重新上传验证，或执行以下命令在临时目录再次调用 EvalArc。
6. 生成试用案例草稿，手动记录实际试用事件。系统不发送邀请。

Blender 案例：生成带遮挡的工作单元，查看原生射线失败与 EvalArc 对照；记录遮挡反馈，保持原几何约束移除遮挡，重新生成与检查后关闭反馈。可下载可编辑 `.blend`、GLB 和原生检查。合成静态场景不是测量得到的工厂孪生。

```bash
npm run verify:bundle -- .state/evidence/camera-bundle.json
PAI_BROWSER=/path/to/google-chrome npm run test:browser
# 或：npx playwright install chromium && npm run test:browser
```

## 实际验证

原生端到端检查通过：基准 **5/10**、相机 **7/10**，相机仍丢失 **1** 个基准成功样本；Holm 调整 p=**1**，不支持总体显著改善。严格保留基准要求下拒绝相机方案，回退基准后重新核验并关闭 seed 9 反馈。原生 EvalArc 对相机返回退出码 1，表示检测到回归，不是流水线错误。

证据见 [验证报告](docs/VERIFICATION.md)。维护者验证、测试夹具和独立试用分别计量。没有独立试用或曝光分母时，独立采用数保持 0，转化率保持未知。

[云端 CI 已通过](https://github.com/noteflowai/pai-design-workbench/actions/runs/37076297416)：最新 Node LTS 验证完整原生与浏览器链路，最新 Current 验证构建、17 组边界测试和原生记录闭环；CDK 基础设施检查也通过。详见报告中的环境与范围。

![AI 工作室：对话计划驱动 Blender 原生构建，实时视口显示遮挡射线](docs/evidence/studio-desktop.png)

工厂孪生：先冻结标准，再逐种子评估 Robot Reel v0.18.0 的真实结果；默认标准下 seed 3、11 产出下降、seed 10 EV 服务 74%，方案被拒绝。

![工厂孪生维护与能源方案评审](docs/evidence/factory-desktop.png)

## 工具边界

| 环节 | 实现与职责 |
|---|---|
| 专业研究 | Radar 原始快照、来源链接、来源自报等级与日期；不直接决定验收 |
| 领域设计 | 冻结需求、比较条件；Blender 原生场景、射线/投影与几何检查；CadQuery/OCCT 参数化零件；动力学待接入 |
| 运行控制 | NoteFlow 原生 text-proposal flow；使用既有预算账本，不初始化或重置预算 |
| 原生验收 | Robot Reel 核验记录与配对统计；生成稳定种子 ID 的 JUnit，交由 EvalArc 对照 |
| AI 工作室 | 确定性意图解析为 Zod 校验的计划；确认后走同一 API；受控模型仅作为显式计划步骤 |
| 工厂孪生 | Robot Reel v0.18.0 逐字节 seeds/manifest；预冻结标准、摘要重算、逐种子保留；不执行上游工具 |
| 参数化 CAD | CadQuery 2.8 / OCCT 7.9 受控配方；STEP/STL/GLB/SVG；B-Rep 实测接口、壁厚、孔边距、质量与装配干涉；STEP 重导入核对 |
| 回放与交付 | 与已核验 manifest 匹配的原始视频；8 文件证据包、哈希与语义核验 |
| 推广反馈 | 案例草稿、匿名事件、反馈状态及新复测回执；不自动发送或发布 |

## 配置

参见 [.env.example](.env.example)。通过 shell 环境设置，或将本地配置写入 `.state/demo.env`。原始提示词、提案、SQLite、导出包与私人控制器路径均保存在被 Git 忽略的 `.state`。

```bash
export PAI_CONTROL_ROOT=/absolute/path/to/noteflow-agent-control
export PAI_CONTROLLER_ENTRYPOINT=/absolute/path/to/.runtime/compiled/flows/execute.js
export PAI_CONTROLLER_DATABASE=/absolute/path/to/existing-reviewed-ledger.sqlite3
```

提案端点不授予验收或发布权限；未知效果返回 `reconcile`，不会自动重试。未连接时仍可完成记录评审。`budget-status` 是只读会计观察，不是对验证命令的预算预留。

默认服务绑定 loopback，拒绝外部 Host 与跨源写入。AWS 模式配置精确 HTTPS Origin，并验证指定 ALB 的 Cognito 登录令牌；面向单个管理工作区，没有用户间数据隔离或匿名公开上传功能。部署复用 WordPress 的 VPC 与 ALB，见 [AWS 部署说明](docs/DEPLOYMENT.md)。

## 开发

```bash
npm run typecheck
npm test
npm run build
npm run test:native
npm run test:browser
```

TypeScript 7.0.2 与当前稳定依赖锁定在 `package-lock.json`。Node 24.21 LTS 与 26.10 Current 在 CI 检查；Blender 5.2.2 使用官方校验和验证。原生依赖固定在安装脚本中，升级需要重新通过原生和浏览器检查。

- [主流工业设计软件界面对比](docs/UI_UX_BENCHMARK.md)
- [工业设计典型测试用例](docs/INDUSTRIAL_TEST_CASES.md)
- [整体架构（权威）](docs/SYSTEM_DESIGN.md) · [核心需求](docs/REQUIREMENTS.md) · [专业规划](docs/ROADMAP.md)
- [系统设计与取舍](docs/ARCHITECTURE.md)
- [Agent 运行时复用决策（acpx / NoteFlow / AgentForge）](docs/AGENT_RUNTIME.md)
- [API 与闭环操作](docs/API.md)
- [后续领域接入和试用计划](docs/NEXT.md)
- [主流工业软件与开源方案](docs/INDUSTRIAL_SOFTWARE.md)
- [多端与最新版本策略](docs/MULTIPLATFORM.md)
- [AWS 部署、登录与备份](docs/DEPLOYMENT.md)
- [Robot Reel Factory Twin 最新复核与接入分工](docs/ROBOT_REEL_INTEGRATION.md)

本仓库新代码使用 MIT；Robot Reel 派生测试数据保留 Apache-2.0 与原始 NOTICE。见 [第三方说明](THIRD_PARTY_NOTICE.md)。
