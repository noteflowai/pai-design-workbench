# 行业对标与开源复用（2026-10）

本文是 [ROADMAP](ROADMAP.md) 的依据：主流厂商在做什么，PAI 的差异化在哪里，每个差距复用哪个成熟开源组件。厂商信息来自 2026 年各自的官方发布，开源项目信息来自各项目的公开发布。版本号和日期以下列项目的官方页面为准，引入前要按[版本只登记一处](SYSTEM_DESIGN.md)的规则重新核对和固定版本。

## 1. 主流厂商动态

| 厂商 | 2026 年关键发布 | 要点 |
|---|---|---|
| Siemens | Eigen Engineering Agent（4 月汉诺威工博会发布并全面可用） | 直接连接 TIA Portal，自主完成 PLC 编程、HMI 画面和设备配置。它会拆解任务、自我校验、反复迭代，直到可以交给人审核。在 19 个国家试点了 100 多家客户，官方称快 2–5 倍，方案质量最多提升 80 % |
| Siemens | CES 2026 与 NVIDIA 共建"工业 AI 操作系统"；年中上线 Digital Twin Composer；4 月与 Humanoid 公司合作把人形机器人部署进工厂 | 覆盖从设计到运营的全链路 AI，并把物理 AI 带进车间 |
| Dassault Systèmes | Virtual Companions：AURA / LEO / MARIE（2 月发布，7 月在 3DEXPERIENCE R2026x 正式可用）；Virtual Twin Factories | 平台定位为"AI 原生的智能体平台"。三个虚拟同事分别负责项目管理、复杂工程和深度科学，共 19 项专业能力，基于行业知识执行工作 |
| Autodesk | Neural CAD 基础模型（2026 年起进入 Fusion 和 Forma）；AU 2026 发布 Autodesk Assistant Builder | Neural CAD 是直接理解几何和拓扑的生成模型，官方称可自动化 80–90 % 的常规设计工作。Assistant Builder 让企业把自己的智能体和 MCP 服务接入 Autodesk Assistant；还推出了智能体化的 PLM |
| Synopsys / Ansys | Ansys 2026 R1（3 月）：SimAI 分 Pro（本地 GPU）和 Premium（云端）两档；新增 GeomAI | 用 AI 代理模型替代部分求解器计算，可评估的设计方案多 10–100 倍；GeomAI 根据参考几何生成满足工程约束的方案 |
| PTC | Creo 13 AI 助手；Onshape AI Advisor（构建在 Amazon Bedrock 上）；Onshape Labs；与 NVIDIA 做 CAD 到机器人的多智能体编排 | 云原生 CAD 记录完整的建模过程，可以直接作为训练 AI 的数据 |
| NVIDIA | 开源物理 AI 智能体技能包（5 月，GTC 台北） | 把 Omniverse、Cosmos、Isaac 等工具做成任何编程智能体都能调用的技能，包括"CAD → 可仿真资产"。Siemens、Dassault、Synopsys、Cadence、PTC 都在用。Pegatron 借助缺陷图像生成技能，模型训练和部署时间缩短了 67 % |

## 2. 六个趋势

1. **从建议到执行。** Siemens Eigen 和 Dassault Companions 都强调"完成工作"，而不是"给出建议"。核心机制是多步推理、自我校验、迭代到可审，最后由人把关。
2. **开放的智能体生态。** Autodesk Assistant Builder 接入 MCP，NVIDIA 技能适用于任何编程智能体。厂商不再只做一个封闭的副驾驶，而是让外部智能体能接进来。
3. **专用工程基础模型。** Neural CAD 和 GeomAI 直接在几何和拓扑上推理，而不是生成文本或代码。
4. **AI 加速仿真。** SimAI 这类代理模型负责快速探索大量方案，正式结论仍然交给求解器。
5. **OpenUSD 打通数字孪生和机器人。** CAD 变更自动同步到 Isaac Sim，物理 AI 训练始终用最新的几何。
6. **物理 AI 进入工厂。** 人形机器人和视觉质检已经在现场落地；合成数据是规模化的关键。

## 3. PAI 的定位：值得自研的只有可信链

PAI 需要的通用能力基本都有成熟的开源实现，没必要从头做；现在已经在用 CadQuery、Gmsh、CalculiX、OpenFOAM、MuJoCo、Blender、OpenUSD、BoTorch 和 Optuna。真正值得自研、主流厂商公开资料里也看不到的，是这条可信链：

> AI 提议 → 原生求解器裁决 → 证据签名（KMS + RFC 3161）→ 发布闸门

**继续自研：**
- 求解器裁决和领域检查规则；
- 证据包：KMS 签名加 RFC 3161 时间戳；
- 发布准入和硬件闸门；
- 自主授权：把开源组件统一包装成"可审计工具"的适配层。

**不自己做：** 物理引擎、代理模型训练框架、VLA 模型、MCP 协议、智能体编排（AgentForge 已有，不再引入 LangGraph 这类框架）、ROS/OPC UA 桥接、AAS 数据模型。

## 4. 差距、对标与复用

| 差距 | 对标 | 直接复用 | 状态 |
|---|---|---|---|
| AI 只做单步"问 AI" | Siemens Eigen 的自主迭代 | 循环在工作台内运行，模型调用走受控执行器和共享账本；不引入新的编排框架 | ✓ 有边界的自主循环（autopilot，见第 5 节） |
| MCP 工具只能读取和提议 | Autodesk Assistant Builder 接入外部 MCP | 官方 MCP SDK；求解工具直接包装现有的 CalculiX、OpenFOAM 调用（可在 AWS Batch 上运行）。mcp-for-blender（原 blender-mcp）和各 freecad-mcp 项目只参考接口设计，不作为依赖 | ✓ `pai_run_plan` 与 `pai_list_grants`，只在授权内执行 |
| 物理代理模型 | Ansys SimAI | NVIDIA PhysicsNeMo（26.08）与 PhysicsNeMo-CFD（DoMINO、Transolver 外流场模型和评测框架）；用"混合初始化"先由代理模型给 OpenFOAM 生成初值，结论仍由求解器给出 | 标量部分用 GP 加求解数据集预热（✓）；场级部分待做（M4） |
| 优化实验管理 | — | Ax（Meta，基于 BoTorch）做多目标、约束和实验管理；需要多学科耦合时再引入 OpenMDAO（NASA） | 已有 BoTorch / Optuna；Ax 待评估 |
| 没有对接 OpenUSD 和物理 AI 工具链 | NVIDIA 技能包，CAD → SimReady → Isaac Sim | Newton（Linux 基金会托管，NVIDIA、DeepMind、Disney 联合开发，基于 Warp 和 OpenUSD，兼容 MuJoCo Playground 和 Isaac Lab）；Isaac Sim 6.0.1 / Isaac Lab；NVIDIA/skills 作为 AgentForge 技能挂载 | 已能导出 MJCF 和通过校验的 OpenUSD；东京开发机的 L40S 可以跑 Isaac Sim（M6） |
| 机器人策略与 VLA | Siemens 人形机器人进厂 | LeRobot v0.6（部署 → 失败样本 → 再训练闭环）与 GR00T N1.7（开放权重、可商用，已集成进 LeRobot）；PAI 只输出机器人模型和场景 | 待做（M6） |
| AI 只看文本和数字 | Neural CAD、GeomAI | 先用顶级模型的视觉能力评审渲染图、应力云图和流场 | 第一版完成：已记录的图像按摘要绑定后发给模型（执行器 PR #60），本机已实测 |
| 加工停留在估算 | — | ocp-freecad-cam（把 CadQuery / build123d 形体直接交给 FreeCAD Path 生成刀路）；OpenCAMLib | DFM 估算已完成（✓）；G-code 待做（M5） |
| 停留在仿真 | 视觉质检、人形机器人进厂 | ros-mcp-server（只加 rosbridge，不改机器人代码）；OPC UA 用 asyncua / open62541；资产数字孪生用 Eclipse BaSyx（AAS，有 Python SDK）；写操作采用灵犀硬件 AI-DLC 的三道闸（顺序、权限、证据） | 第一阶段只开放读取和仿真；实测通过的那一级才把 `physicalValidation` 标为 true（M8） |

## 5. 已落地：有边界的自主

**授权。** 维护者为一个项目签发授权（autonomy grant），写明：
- 允许的原生工具；
- 次数上限；
- 有效期。

授权只覆盖测量类工具：CAD 检查、生成代码、寻优、机器人工作单元、产线、气动。

**在授权内执行的规则。** 计划步骤可以不再逐步点确认就运行，人工确认原有的规则全部保留，另外加四条：
- 放宽要求、修改需求、有依赖的步骤都会被拒绝；
- 次数在启动前先预留，启动失败时退回；
- 授权撤销或过期后什么都不执行；
- 每次执行都记在计划和授权上（`by: grant`）。

验收、发布和反馈仍然只能由人处理。

**两种调用方。**
- **工作台内的 autopilot**：每一轮经受控执行器（共享账本、不自动重试）请模型给出一个计划，在授权内执行，等原生结论，把实测的失败项交给下一轮。满足以下任一条件就停止：
  - 达成目标；
  - 轮数用完；
  - 授权用完；
  - 没有可执行的计划；
  - 需要人工核对。
- **外部 Agent**：AgentForge 会话经治理网关调用 `pai_list_grants` 和 `pai_run_plan`。托管站点需要单独的 OAuth scope `pai-agent/run`。

实测证据见 [VERIFICATION.md](VERIFICATION.md)。

## 6. 许可证边界

| 组件 | 许可证 | 用法 |
|---|---|---|
| OpenFOAM、CalculiX、Blender | GPL | 只作为外部进程调用（固定版本的镜像或二进制），不链接进代码 |
| FreeCAD（及 FreeCAD Path） | LGPL | 外部进程或动态库调用 |
| MuJoCo、Newton、PhysicsNeMo、LeRobot | Apache-2.0（以各仓库 LICENSE 为准，引入前复核） | 作为依赖使用 |
| GR00T N1.7 | 开放权重，可商用 | 使用前按模型卡核对许可条款 |
| 社区 MCP 项目 | 各不相同，未逐个核对 | 只参考设计，不引入代码 |
