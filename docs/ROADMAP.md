# 专业规划（2026-10-03 起）

按价值和依赖关系排序，不按周排期。每个里程碑都有退出条件，必须有工具输出作证据。需求编号见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 当前基线（已验证）

演示 A 的完整闭环已在托管站点实时跑通：MuJoCo 拒绝 → AI 修正 → CalculiX 否决 → AI 种子物理寻优 → 正式复核 → 反馈关闭 → 发布 → KMS 签名、RFC 3161 时间戳。CAD → MJCF / OpenUSD 已打通。AgentForge 网关示例和 acpx 0.19.4 已在底座的 CodeBuild 上验证通过。

## M1 · 优化与证据收尾

| 项 | 需求 | 退出条件 |
|---|---|---|
| BoTorch qLogNEHVI 策略 | F7b | ✓ 端到端测试通过、界面可选；✓ 三个种子配对比较：超体积 1.056 vs 0.482，最轻质量持平，耗时约为 3–4 倍。结论：求最轻可行用 NSGA-II，梳理质量—刚度权衡用 BoTorch。待做：托管站点安装 BoTorch |
| Object Lock 归档开启 | F15 | 用户确认保留期；托管站点归档 1 个发布并读回 COMPLIANCE 锁和版本 |
| 基础镜像推广 | — | 拿到 ECR 扫描结果的读权限后审查；由维护者推广 `:full` 并更新 `base-image.lock` |

## M2 · 与 AgentForge 深度融合

| 项 | 需求 | 退出条件 |
|---|---|---|
| PAI 技能经底座的技能分发机制提供 | F17 | ✓ 已完成：按底座的分层，技能内容属于运营方叠加层，不放进底座 `skills/`。`examples/pai-workbench/install-skill.mjs` 在固定提交拉取技能，核对文件摘要，再用 `computeSkillDigest` 锁定；底座的 `skills-config.mjs` 分发到会话时重新核验，篡改会被拒绝（`integrity_failed`） |
| 物理推理评测 | F17 | ✓ 测评框架已完成（PR #549 `c09154f`，CodeBuild 3 条全过）：复用底座 `eval/runner.mjs` 跑 golden task `estimate-bracket-deflection`，用工作区外的评分程序对照 9 个留出的 CalculiX 结果；纯 t³ 估算不通过，参考解通过。待做：通过受控执行器用真实模型跑一次并记录分数 |
| Host 通道闸门 | — | AGENT_RUNTIME 的 6 个闸门逐项给出证据，满足后才实现"提议 → 原生检查 → 修订"的多轮循环 |

## M3 · 规模化求解

| 项 | 需求 | 退出条件 |
|---|---|---|
| AWS Batch 跑 FEA | F18 | ✓ `PAISolver` 栈：Fargate amd64，镜像不可变，每个点一个作业，失败不重试；托管站点上一次寻优跑完 5 个作业；参考件与本机结果一致 |
| 求解数据集 | F20 前置 | 每个实测点（参数、网格、结果、摘要）进入只追加的数据集，作为代理模型的训练来源 |

## M4 · 演示 B：气动

| 项 | 需求 | 退出条件 |
|---|---|---|
| OpenFOAM 通道 | F19 | ✓ 本机完成：官方镜像 v2512 固定 digest，两级网格，4 项检查，接入反馈、准入和 AI 工具 `aero-body`。待做：在 Batch 上跑 OpenFOAM 作业，加边界层网格和更细的网格层级，降低网格依赖 |
| PhysicsNeMo 代理模型 | F20 | 在 DrivAerML 或自有数据上训练；只排序；前 k 个回到 OpenFOAM 实测 |

## M5 · 制造与第二个零件族

| 项 | 需求 | 退出条件 |
|---|---|---|
| DFM / CAM | F21 | 一个 CAM 或切片 CLI 原生检查，给出加工时间和成本，纳入准入 |
| 第二个零件族 | F22 | 夹爪指或相机支架，同样有 B-Rep、FEA 和 MuJoCo 装配 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| 真实模型输出偏离契约（例：`dependsOn: null`） | 只在展示字段和 null 上宽松，结构字段严格；错误给出字段路径；每次真实调用都录回执 |
| 依赖体积（PyTorch） | 用 CPU 版并单独锁定，作为可选安装；托管站点按需安装 |
| 不可逆操作（Object Lock） | 默认关闭，开启需要显式确认 |
| 底座和工作台各自漂移 | 契约测试跨仓核对；版本只登记一处；手动跑 CodeBuild 验证 PR |
| 把仿真误称为验证 | 所有记录带 `physicalValidation: false`；文案写明适用范围 |
