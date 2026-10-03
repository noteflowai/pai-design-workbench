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
| F7b | 优化策略可选 BoTorch qLogNEHVI：约束批量采集 + 几何多保真先验 | `PAI_OPTIMIZE_STRATEGY=botorch-qlognehvi npm run test:optimize`（本机：7 次求解，5 个可行，代理模型校准误差 4–8 %，正式复核通过） | 已验证（本机；CI 和托管站点尚未安装 BoTorch 锁文件） |
| F8 | MuJoCo 工作单元：IK、500 Hz 动力学、碰撞、节拍、10 个种子配对 | `test:robot` | 已验证 |
| F9 | 已通过的 CAD 零件装到机械臂末端（精确网格质量与 B-Rep 差值 ≤ 3 %）；导出 MJCF 与 OpenUSD（28 个校验器） | `test:robot` | 已验证 |
| F10 | Blender 工作单元和产线布局，射线实测通道、围栏、相机覆盖 | `test:blender`、`test:plant` | 已验证 |
| F11 | 失败回放；反馈状态机；复测绑定修正方案 | 浏览器测试 "robot cell closed loop" | 已验证 |
| F12 | 发布准入 5 项 + 人工批准；需求修订后自动废止 | 浏览器测试 "release gate" | 已验证 |
| F13 | 签名发布包：KMS ECDSA P-256；界面内和离线核验；篡改可检出 | `test:package`；托管核验 | 已验证 |
| F14 | RFC 3161 可信时间戳；发布只封存一次，重复下载字节相同 | `tests/seal.test.ts`；托管 DigiCert | 已验证 |
| F15 | S3 Object Lock 写一次归档 | 单元测试；桶已创建 | 部分（需确认保留期后开启） |
| F16 | 外部 Agent 经 AgentForge 网关读取和提议；托管站点用客户端凭据 | 网关策略测试；托管 401/404 检查 | 已验证 |
| F17 | PAI 技能经底座的技能分发机制提供并锁定摘要；用 `eval/` 度量模型的物理估算 | `examples/pai-workbench/skill.test.mjs`；分发器手工核验 | 部分（技能分发已完成；物理推理评测待做） |
| F18 | FEA 批量扩展到 AWS Batch，每个点一个作业，结果同样经摘要核验 | 托管 Batch 作业回执 | 待做 |
| F19 | 流体通道：OpenFOAM（snappyHexMesh + simpleFoam），网格无关性检查 | 原生 e2e | 待做 |
| F20 | 物理 AI 代理模型 PhysicsNeMo：用自己积累的求解数据训练，只负责排序 | 留出集误差 + 实测复核 | 待做 |
| F21 | 可制造性：CAM 或切片 CLI 检查，加工时间和成本 | 原生 e2e | 待做 |
| F22 | 第二个零件族，以及 FreeCAD / build123d 文档 | 原生 e2e | 待做 |

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
