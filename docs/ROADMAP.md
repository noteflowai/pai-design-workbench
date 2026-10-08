# 专业规划（2026-10-03 起）

按价值和依赖关系排序，不按周排期。每个里程碑都有退出条件，必须有工具输出作证据。需求编号见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 当前基线（已验证）

演示 A 的完整闭环已在托管站点实时跑通：MuJoCo 拒绝 → AI 修正 → CalculiX 否决 → AI 种子物理寻优 → 正式复核 → 反馈关闭 → 发布 → KMS 签名、RFC 3161 时间戳。CAD → MJCF / OpenUSD 已打通。AgentForge 网关示例和 acpx 0.19.4 已在底座的 CodeBuild 上验证通过。

## M1 · 优化与证据收尾

| 项 | 需求 | 退出条件 |
|---|---|---|
| BoTorch qLogNEHVI 策略 | F7b | ✓ 端到端测试通过、界面可选；✓ 三个种子配对比较：超体积 1.056 vs 0.482，最轻质量持平，耗时约为 3–4 倍。结论：求最轻可行用 NSGA-II，梳理质量—刚度权衡用 BoTorch。✓ 托管站点已安装并实测 |
| Object Lock 归档开启 | F15 | 用户确认保留期；托管站点归档 1 个发布并读回 COMPLIANCE 锁和版本 |
| 基础镜像推广 | — | 拿到 ECR 扫描结果的读权限后审查；由维护者推广 `:full` 并更新 `base-image.lock` |

## M2 · 与 AgentForge 深度融合

| 项 | 需求 | 退出条件 |
|---|---|---|
| PAI 技能经底座的技能分发机制提供 | F17 | ✓ 已完成：按底座的分层，技能内容属于运营方叠加层，不放进底座 `skills/`。`examples/pai-workbench/install-skill.mjs` 在固定提交拉取技能，核对文件摘要，再用 `computeSkillDigest` 锁定；底座的 `skills-config.mjs` 分发到会话时重新核验，篡改会被拒绝（`integrity_failed`） |
| 物理推理评测 | F17 | ✓ 测评框架已完成（PR #549 `c09154f`，CodeBuild 3 条全过）：复用底座 `eval/runner.mjs` 跑 golden task `estimate-bracket-deflection`，用工作区外的评分程序对照 9 个留出的 CalculiX 结果；纯 t³ 估算不通过，参考解通过。✓ 真实模型已测：Kiro 2.27.1（claude-opus-5.5）中位误差 11.4 %、最差 32.1 %、Spearman 0.95，通过；板厚和宽度趋势判断正确，高度趋势方向错误 |
| Host 通道闸门 | — | AGENT_RUNTIME 的 6 个闸门逐项给出证据，满足后才实现"提议 → 原生检查 → 修订"的多轮循环 |

## M3 · 规模化求解

| 项 | 需求 | 退出条件 |
|---|---|---|
| AWS Batch 跑 FEA | F18 | ✓ `PAISolver` 栈：Fargate amd64，镜像不可变，每个点一个作业，失败不重试；托管站点上一次寻优跑完 5 个作业；参考件与本机结果一致 |
| 求解数据集 | F20 前置 | ✓ `GET /api/dataset/solver`：从已存记录导出，不重算也不插值，每行注明来源记录和求解器版本，整体带摘要；托管站点 77 行 |

## M4 · 演示 B：气动

| 项 | 需求 | 退出条件 |
|---|---|---|
| OpenFOAM 通道 | F19 | ✓ 本机完成：官方镜像 v2512 固定 digest，两级网格，4 项检查，接入反馈、准入和 AI 工具 `aero-body`。✓ 托管站点经 AWS Batch 跑（9 分钟，Cd 与本机一致）。待做：加边界层网格和更细的网格层级，降低网格依赖 |
| PhysicsNeMo 代理模型 | F20 | 前提条件：有场级数据（CFD 速度场/压力场或 DrivAerML）。标量部分已改为用数据集给 GP 预热（✓）。不提前引入深度学习依赖 |

## M5 · 制造与第二个零件族

| 项 | 需求 | 退出条件 |
|---|---|---|
| DFM / CAM | F21 | ✓ 三轴铣削 DFM 已纳入 CAD 检查和准入。✓ FreeCAD 1.1 CAM + OpenCAMLib 按装夹出 G-code，独立 0.1 mm 高度图仿真（过切、残料、过载、快移碰撞、节拍），托管站点经 AWS Batch 运行（演示 D）。待做：用实际机床节拍校准加工时间 |
| 第二个零件族 | F22 | ✓ 6202 轴承座：自有配方与 B-Rep 检查、AI 生成代码、DFM/CAM、结构 FEA（轴承余弦载荷，加测受载失圆）、设计空间扫描和物理寻优（本机或 AWS Batch），全部在托管站点复跑一致。待做：MuJoCo 装配（轴承座作为工作单元的固定件） |

## 层级状态（对齐外部分析）

| 层 | 状态（只写跑过的结果） | 下一步 |
|---|---|---|
| 0 意图 → 类型化需求 | 完成：Zod 计划、MCP、AgentForge 网关与集成包、客户端凭据 Agent API | — |
| 1 概念 | 未做 | 等出现明确的造型需求（Hunyuan3D / TRELLIS） |
| 2 工程几何 | 两个零件族（NEMA 17 支架、6202 轴承座）+ 生成代码；Ahmed 车身配方 | 第三个零件族按真实需求再加 |
| 3 高保真求解 | CalculiX（两级网格，两个零件族各有载荷工况，共用 `fea_core.py`）；OpenFOAM v2512（两级网格）；都能在 AWS Batch 上跑 | 加 CFD 边界层网格和更细的网格 |
| 4 物理 AI 代理模型 | GP 只负责排序，带校准；用求解数据集预热（46.3 → 44.1 g） | 有场级数据后再做 PhysicsNeMo |
| 5 优化 | NSGA-II、BoTorch qLogNEHVI（支架，做过配对比较）；轴承座以失圆为约束的 GP + NSGA-II | 轴承座的 BoTorch 线性约束 |
| 6 系统 / 机器人 | MuJoCo 工作单元、CAD 装到机械臂、MJCF/OpenUSD（28 个校验器） | Isaac Lab 策略 |
| 7 可制造性 | 三轴铣削 DFM/DFA；CAM 出 G-code 并独立仿真 | 用实际机床节拍校准 |
| 8 证据 | KMS 签名、RFC 3161 时间戳、只封存一次；Object Lock 桶已就绪 | 需确认保留期后开启归档 |

## M5–M8 · 从仿真走向物理世界（依据：[INDUSTRY_BENCHMARK.md](INDUSTRY_BENCHMARK.md)）

| 里程碑 | 复用 | 完成标准 |
|---|---|---|
| M5 自主闭环（✓） | 授权 + autopilot + `pai_run_plan`；循环由工作台和 AgentForge 承担，不引入新的编排框架 | ✓ 界面里签发授权、给目标、逐轮看原生结论、核对后继续、撤销；✓ 真实模型实跑：Codex 为轴承座给出参数化修正，核对后在授权内执行，原生检查通过（150.654 g，边距 14 mm，见 VERIFICATION）；✓ AI 战绩按引擎记录求解器判定并回传给模型。待做：执行器账本对已核对的 Codex 尝试的处理（noteflow-agent-control#128） |
| M6 代理模型预筛（已评估，移出评审） | PhysicsNeMo-CFD 固定提交 + DoMINO 检查点（上游 `DoMINOInference` 原样复用） | 校准门禁 ≥ 6 个车身、Spearman ≥ 0.8；12 个车身 Spearman −0.35，未通过，从未影响结论，已从评审中移除。适配器与校准工具保留；先让 OpenFOAM 保留表面场，用自有数据按上游 `domino_nim_finetuning` 微调后再评估 |
| M7 USD → 机器人策略（第一步 ✓） | Newton / Isaac Lab（L40S）、NVIDIA/skills 挂到 AgentForge、LeRobot + GR00T N1.7 | ✓ 导出的 USD 能被 Newton 1.6 导入为一个关节树，33 个构型的正运动学与 MJCF 一致（0.45 µm），过程中修掉了两个 UsdValidation 没查出的导出错误。待做：在 Newton / Isaac Lab 上跑出策略成功率，作为新的检查项 |
| M8 设计到制造与实测回流（G-code ✓，首件检验 ✓） | ocp-freecad-cam / OpenCAMLib 出 G-code；ros-mcp-server、asyncua、BaSyx 第一阶段只读；硬件三道闸 | ✓ G-code 经独立切削仿真校验（[CAM.md](CAM.md)，演示 D）；✓ 首件检验：按冻结公差生成检验计划，实测值逐项判定，结果随发布签名（`physicalMeasurement: true`，见 [VERIFICATION.md](VERIFICATION.md)）；✓ CMM 报告导入（QIF 3.0 Results 与 CSV）；待做：应变实测回写、ROS / OPC UA 只读 |
| 多模态评审（✓ 第一版） | 顶级模型的视觉能力；执行器 PR #60 支持按摘要绑定图像 | ✓ 渲染图、相机视图和 FEA 应力云图（`fea.png`）已能进入评审，界面上有"带图问 AI"；盲测对照 6/6 与射线检查一致（容易情形）。✓ 执行器固定版本已更新（`bf438e4`）。待做：流场图；更难的盲测（局部遮挡、应力集中位置） |

## M9 · 制品库与流程编排（交付制品，见 [ADR 0001](adr/0001-artifacts-and-workflows.md)）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 9a 纵向切片 | 制品契约与注册表、生命周期、签名制品包、导入与新环境复现；JSON 流程（条件、人工确认、恢复）；用量分开记录；第一个制品：场外物流规划（OR-Tools）；管理界面 | ✓ 本机（F30–F34），`npm run test:artifacts` |
| 9b 托管 | 主机安装 OR-Tools（`infra/update_release.sh`），托管站点上跑同一流程 | 已接入部署脚本，待托管验证 |
| 9c 第二个制品 | 第一个 `kind: "model"` 制品（权重按摘要登记），验证适配器接口不需要改动 | 计划 |
| 9d 长任务与调度 | 长时间节点交给 noteflow-auto 执行（调度、故障转移、账本），PAI 只保留契约与核验 | 计划 |
| 9e 租户与结算 | 多租户鉴权和隔离；价格版本、按 Token / 原生计算结算 | 计划；当前单租户，计费未上线 |
| 9f 分发 | 跨组织分发时把同一份包作为 OCI artifact（ORAS）推送，签名不变 | 按需 |

"PAI 做 80–90%"是目标：按每个交付记录平台复用部分与定制部分的工作量，样本足够后再统计，目前不作结论。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 真实模型输出偏离契约（例：`dependsOn: null`） | 只在展示字段和 null 上宽松，结构字段严格；错误给出字段路径；每次真实调用都录回执 |
| 依赖体积（PyTorch） | 用 CPU 版并单独锁定，作为可选安装；托管站点按需安装 |
| 不可逆操作（Object Lock） | 默认关闭，开启需要显式确认 |
| 底座和工作台各自漂移 | 契约测试跨仓核对；版本只登记一处；手动跑 CodeBuild 验证 PR |
| 把仿真误称为验证 | 所有记录带 `physicalValidation: false`；文案写明适用范围 |

## 试用与判定

First pilot: an authorized robot experiment owner brings a permitted recording and one concrete decision. Record setup time, evidence reopening, whether the decision changed, unresolved questions, second use and existing preferred workflow. Maintainer trials stay separate. Capture actual observations; do not invent outreach, users or conversion.

Go/no-go after 3 independent tasks: at least 2 can be reproduced from supplied evidence; no critical missing artifacts; at least 1 owner uses it a second time. These are proposed pilot criteria, not observed results.
