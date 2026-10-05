# 核心功能需求（2026-10-03）

每条需求都有编号和验收方式。状态只写实际验证过的结果：

- **已验证**：有测试或回执；
- **部分**：已实现但范围有限；
- **待做**：还没有实现。

架构见 [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md)，排期见 [ROADMAP.md](ROADMAP.md)。

## 目标用户与场景

- **用户**：机器人工作单元集成工程师、夹具和支架机械设计师、产线规划师、Physical AI 实验负责人。
- **主场景（演示 A）**：节拍目标收紧，带来工作单元和支架的连锁修改。要求物理上成立，并交付可核验的证据。
- **次场景（演示 B）**：外形气动优化，用 OpenFOAM 求解，DrivAerML 训练代理模型。目前只有规划。

## F. 功能需求

| ID | 需求 | 验收方式 | 状态 |
|---|---|---|---|
| F1 | 用一句话或表单创建任务，冻结需求；修订只追加，可逐项比较 | `tests/*`；版本对比界面 | 已验证 |
| F2 | AI 把意图解析成类型化计划，标出收紧或放宽；确认前不执行 | 契约测试；浏览器测试 "AI engine" | 已验证 |
| F3 | 真实模型（Kiro 主账号 → 备用 → 二备）经受控执行器调用；不确定的结果走核对 | 托管录制；`test:agentcore-live` | 已验证 |
| F4 | 参数化 CAD（NEMA 17 支架）：B-Rep 检查 7 项；导出 STEP、STL、GLB、SVG | `test:cad` | 已验证 |
| F5 | AI 生成 CadQuery 代码，在三层沙箱中运行；结论用同一套检查 | `test:cad-code`；AgentCore microVM | 已验证 |
| F6 | 结构 FEA：Gmsh C3D10 + CalculiX，两级网格；挠度和应力纳入准入 | `test:fea` | 已验证 |
| F7 | 物理寻优：AI 种子（附估算）+ Sobol → 代理模型排序 → 几何筛查 → 求解器实测 → 正式复核 | `test:optimize`；演示 A | 已验证 |
| F7b | 优化策略可选 BoTorch qLogNEHVI：约束批量采集 + 几何多保真先验 | `PAI_OPTIMIZE_STRATEGY=botorch-qlognehvi npm run test:optimize`（本机：7 次求解，5 个可行，代理模型校准误差 4–8 %，正式复核通过） | 已验证（本机；三个种子配对比较见 [optimizer-compare.json](evidence/optimizer-compare.json)：超体积约为 NSGA-II 的 2.2 倍，最轻质量持平；托管站点已安装 BoTorch 0.18.1（`PAI_PHYSICS_BOTORCH=1`，哈希锁定）：一次寻优 12 次求解全部跑在 Batch 上，其中 8 个是 BoTorch 提出的点，9 个可行，代理模型误差 < 2 %） |
| F8 | MuJoCo 工作单元：IK、500 Hz 动力学、碰撞、节拍、10 个种子配对 | `test:robot` | 已验证 |
| F9 | 已通过的 CAD 零件装到机械臂末端（精确网格质量与 B-Rep 差值 ≤ 3 %）；导出 MJCF 与 OpenUSD（28 个校验器） | `test:robot` | 已验证 |
| F10 | Blender 工作单元和产线布局，射线实测通道、围栏、相机覆盖 | `test:blender`、`test:plant` | 已验证 |
| F11 | 失败回放；反馈状态机；复测绑定修正方案 | 浏览器测试 "robot cell closed loop" | 已验证 |
| F12 | 发布准入 5 项 + 人工批准；需求修订后自动废止 | 浏览器测试 "release gate" | 已验证 |
| F13 | 签名发布包：KMS ECDSA P-256；界面内和离线核验；篡改可检出 | `test:package`；托管核验 | 已验证 |
| F14 | RFC 3161 可信时间戳；发布只封存一次，重复下载字节相同 | `tests/seal.test.ts`；托管 DigiCert | 已验证 |
| F15 | S3 Object Lock 写一次归档 | 单元测试；桶已创建 | 部分（需确认保留期后开启） |
| F16 | 外部 Agent 经 AgentForge 网关读取和提议；托管站点用客户端凭据 | 网关策略测试；托管 401/404 检查 | 已验证 |
| F17 | PAI 技能经底座的技能分发机制提供并锁定摘要；用 `eval/` 度量模型的物理估算 | `examples/pai-workbench/skill.test.mjs`；分发器手工核验 | 已验证：Kiro 2.27.1（claude-opus-5.5）经受控执行器跑评测，中位误差 11.4 %、最差 32.1 %、Spearman 0.95，通过；高度趋势方向判断错误。见 [physics-eval.json](evidence/physics-eval.json) |
| F18 | FEA 批量扩展到 AWS Batch，每个点一个作业，结果同样经摘要核验 | 托管寻优：5 个 Batch 作业，摘要与版本核对；单点与本机结果一致（0.0478 mm），见 [solver-batch.json](evidence/solver-batch.json) | 已验证 |
| F19 | 流体通道：OpenFOAM v2512（固定 digest 的官方 OpenCFD 镜像）+ CadQuery 生成 Ahmed 型车身；snappyHexMesh 两级网格 + simpleFoam k-ω SST；检查阻力、网格收敛、迭代收敛、网格质量 | `npm run test:aero`；角度扫描与 Ahmed 1984 实验对照，见 [AERO.md](AERO.md) | 已验证：本机，以及托管站点经 AWS Batch 跑（16 vCPU，9 分钟，本机 94 分钟；Cd 与本机一致，见 [aero-batch.json](evidence/aero-batch.json)） |
| F20 | 物理 AI 代理模型 PhysicsNeMo：用自己积累的求解数据训练，只负责排序 | 留出集误差 + 实测复核 | 已验证（标量设计空间部分）：求解数据集直接给寻优的 GP 预热，最轻可行质量从 46.33 g 降到 44.14 g，求解次数从 16.5 次降到 14.5 次，见 [warm-start.json](evidence/warm-start.json)。PhysicsNeMo 是有意不用：标量数据量小，GP 足够；等有场级数据（DrivAerML 或 CFD 场）再做 |
| F21 | 可制造性：三轴铣削 DFM，在 B-Rep 上实测最少装夹方向（精确覆盖，孔只算无遮挡的钻削通道）、孔深径比、紧固件可装配性（DFA，ISO 4762 螺钉头空间）、单件成本估算（车间参数放在 `native/dfm-shop.json`，经审查）；作为可选冻结要求进入 CAD 检查和 EvalArc | `npm run test:cad`：2 次装夹；参考件 17.22 EUR 超出 16 EUR 目标；紧凑型 14.69 EUR 但 2 个 M5 孔被加强筋压住，螺钉装不进，结论为拒绝 | 已验证（估算，不是报价；未做 CAM 刀路仿真） |
| F22 | 第二个零件族，以及 FreeCAD / build123d 文档 | 原生 e2e | 待做 |

| F23 | 有边界的自主：维护者签发授权（工具、次数、有效期），autopilot 在授权内多轮执行"提议 → 原生检查 → 修改"；放宽要求、修改需求一律拒绝；不能验收或发布 | `tests/autonomy.test.ts`；本机实测：Kiro 2.27.1 写 CadQuery 代码，第 1 轮通过（40.59 g） | 已验证（本机） |
| F24 | 外部 Agent 在授权内触发原生求解：`pai_list_grants`、`pai_run_plan`；托管站点用单独的 `pai-agent/run` scope | 真实 AgentForge Host 会话（Kiro + acpx 0.19.4 + 治理网关）：提议 → 执行 → 读取结论，整条链跑通 | 已验证（本机）；托管站点待部署 |
| F25 | 多模态评审：已记录的原生图像（渲染图、检查视图）随文本上下文发给模型，结论仍以求解器为准 | `POST /api/assistant/ai` 加 `attachments`（只接受记录里登记过、摘要一致的 PNG/JPEG，最多 3 张）；执行器 PR [noteflow-agent-control#60](https://github.com/noteflowai/noteflow-agent-control/pull/60) 让图像按摘要绑定；本机实测：Kiro 2.27.1 看出遮挡工作单元渲染图里挡住视线的块体；盲测对照 6/6 与射线检查一致（样本小、属容易情形） | 已验证：执行器 PR 已合并，固定版本更新为 `bf438e4`（`accepts: ["images"]`，安装时据此设置 `PAI_EXECUTOR_IMAGES`），用固定版本重跑盲测仍是 6/6。应力云图已导出为 `fea.png`（原生 Blender 渲染，按摘要登记，可作附件）；流场图待做 |
| F28 | 导出的 OpenUSD 与仿真用的 MJCF 是同一台机器人：Newton 导入为一个关节树，质量一致，正运动学一致 | `npm run test:robot`（配置 Newton 时断言）；[newton-usd.json](evidence/newton-usd.json) | 已验证（本机与托管站点） |
| F27 | AI 气动预筛：NVIDIA DoMINO（PhysicsNeMo-CFD）在同一 STL 上预估 Cd，与原生求解并行，只作参考；按校准门禁决定能否参与排序 | `tools/prescreen_calibrate.py`；`npm run test:aero` 在配置 GPU 时断言预筛已登记且不进入检查 | 部分：已集成并登记；校准未通过（12 个车身 Spearman −0.35），见 [AERO.md](AERO.md) |
| F29 | CAM：FreeCAD 1.1 CAM（ocp-freecad-cam）+ OpenCAMLib 按装夹生成 G-code，独立的高度图切削仿真检查过切、残料、刀具过载和快移碰撞，并给出节拍 | `npm run test:cam`；4 个注入故障的反例全部被拒绝，见 [CAM.md](CAM.md) | 已验证：本机；托管站点上程序由 PAISolver Batch 作业生成、在主机上独立仿真，参考支架通过（[cam-batch.json](evidence/cam-batch.json)） |
| F26 | 虚实结合：G-code（ocp-freecad-cam）、实测数据回流；只有实测通过的那一级才把 `physicalValidation` 标为 true；写操作经硬件三道闸 | 待定 | 待做 |

## N. 非功能需求

| ID | 需求 | 验收方式 | 状态 |
|---|---|---|---|
| N1 | 每个引擎和依赖只在一处固定版本；引擎保持最新 | 不允许写死版本号的测试；PyPI / npm 现查 | 已验证 |
| N2 | 不确定的运行不自动重放；请求身份可重入 | 单元测试 | 已验证 |
| N3 | 原生产物读取时重新核对摘要 | 文件路由 422 | 已验证 |
| N4 | WCAG 2.1 AA；390 px 宽度下可用 | 浏览器 a11y 测试 | 已验证 |
| N5 | 托管部署不改动 WordPress 的规则；发布可回退 | `verify-infra`；SSM 保留上一版 | 已验证 |
| N6 | 最小权限 IAM；不为恢复任务放宽权限 | CDK 模板审查 | 已验证 |
| N7 | 公开证据里不出现账号 ID 或 ARN；提交前扫描密钥 | gitleaks；证据 grep | 已验证 |
| N8 | 单个寻优 ≤ 28 次求解；默认预算约 8–15 分钟 | `MAX_OPTIMIZE_EVALUATIONS` | 已验证 |

## 范围外（明确不做）

- 认证级 FEA、疲劳和公差叠加；
- 现场安全认证；
- 自动发布或对外发送；
- 多租户数据隔离（当前只有一个管理工作区）；
- 把仿真当作物理验证。
