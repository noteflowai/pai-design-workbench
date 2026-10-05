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
| DFM / CAM | F21 | ✓ 三轴铣削 DFM 已纳入 CAD 检查和准入。待做：用 FreeCAD Path 或 CAM CLI 做刀路仿真，校准加工时间 |
| 第二个零件族 | F22 | 夹爪指或相机支架，同样有 B-Rep、FEA 和 MuJoCo 装配 |

## 层级状态（对齐外部分析）

| 层 | 状态（只写跑过的结果） | 下一步 |
|---|---|---|
| 0 意图 → 类型化需求 | 完成：Zod 计划、MCP、AgentForge 网关与集成包、客户端凭据 Agent API | — |
| 1 概念 | 未做 | 等出现明确的造型需求（Hunyuan3D / TRELLIS） |
| 2 工程几何 | 一个零件族 + 生成代码；Ahmed 车身配方 | 第二个零件族（F22） |
| 3 高保真求解 | CalculiX（两级网格）；OpenFOAM v2512（两级网格）；两者都能在 AWS Batch 上跑 | 加 CFD 边界层网格和更细的网格 |
| 4 物理 AI 代理模型 | GP 只负责排序，带校准；用求解数据集预热（46.3 → 44.1 g） | 有场级数据后再做 PhysicsNeMo |
| 5 优化 | NSGA-II、BoTorch qLogNEHVI，做过配对比较 | — |
| 6 系统 / 机器人 | MuJoCo 工作单元、CAD 装到机械臂、MJCF/OpenUSD（28 个校验器） | Isaac Lab 策略 |
| 7 可制造性 | 三轴铣削 DFM（装夹、孔、成本估算） | 用 CAM 刀路校准加工时间 |
| 8 证据 | KMS 签名、RFC 3161 时间戳、只封存一次；Object Lock 桶已就绪 | 需确认保留期后开启归档 |

## M5–M8 · 从仿真走向物理世界（依据：[INDUSTRY_BENCHMARK.md](INDUSTRY_BENCHMARK.md)）

| 里程碑 | 复用 | 完成标准 |
|---|---|---|
| M5 自主闭环（✓ 第一版） | 授权 + autopilot + `pai_run_plan`；循环由工作台和 AgentForge 承担，不引入新的编排框架 | 本机 autopilot 达成目标；外部 Agent 能在授权内完成提议 → 执行 → 读取结论；托管站点开通 `run` scope 后实测 |
| M6 代理模型预筛（进行中） | PhysicsNeMo-CFD 固定提交 + DoMINO 检查点（上游 `DoMINOInference` 原样复用）；评审中与 OpenFOAM 并行跑，按摘要登记，只作参考 | 校准门禁：≥ 6 个车身、Spearman ≥ 0.8 才可参与排序。当前 12 个车身 Spearman −0.35，未通过（Ahmed 车身在训练分布外；漏掉 40° 阻力突增和尖头罚分）；下一步用自有 OpenFOAM 场数据按上游 `domino_nim_finetuning` 微调，通过后再做混合初始化 |
| M7 USD → 机器人策略（第一步 ✓） | Newton / Isaac Lab（L40S）、NVIDIA/skills 挂到 AgentForge、LeRobot + GR00T N1.7 | ✓ 导出的 USD 能被 Newton 1.6 导入为一个关节树，33 个构型的正运动学与 MJCF 一致（0.45 µm），过程中修掉了两个 UsdValidation 没查出的导出错误。待做：在 Newton / Isaac Lab 上跑出策略成功率，作为新的检查项 |
| M8 设计到制造与实测回流（G-code ✓） | ocp-freecad-cam / OpenCAMLib 出 G-code；ros-mcp-server、asyncua、BaSyx 第一阶段只读；硬件三道闸 | ✓ G-code 经独立切削仿真校验（[CAM.md](CAM.md)）；待做：三坐标或应变实测回写证据，只有这一级才把 `physicalValidation` 标为 true |
| 多模态评审（✓ 第一版） | 顶级模型的视觉能力；执行器 PR #60 支持按摘要绑定图像 | ✓ 渲染图、相机视图和 FEA 应力云图（`fea.png`）已能进入评审，界面上有"带图问 AI"；盲测对照 6/6 与射线检查一致（容易情形）。✓ 执行器固定版本已更新（`bf438e4`）。待做：流场图；更难的盲测（局部遮挡、应力集中位置） |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 真实模型输出偏离契约（例：`dependsOn: null`） | 只在展示字段和 null 上宽松，结构字段严格；错误给出字段路径；每次真实调用都录回执 |
| 依赖体积（PyTorch） | 用 CPU 版并单独锁定，作为可选安装；托管站点按需安装 |
| 不可逆操作（Object Lock） | 默认关闭，开启需要显式确认 |
| 底座和工作台各自漂移 | 契约测试跨仓核对；版本只登记一处；手动跑 CodeBuild 验证 PR |
| 把仿真误称为验证 | 所有记录带 `physicalValidation: false`；文案写明适用范围 |
