# 实际验证记录

2026-09-30，最新 Node 24.21.0 LTS、TypeScript 7.0.2、Blender 5.2.2 LTS。

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

仍未完成：新的策略推理、动力学/关节可达性/现场验证、参数化 CAD 与 DFM、独立用户试用、用户间工作区隔离、桌面/移动原生壳。AWS 单管理工作区的远程认证已实现。模型控制接口已实现；预算账本未配置，未执行真实模型提案。没有发送邀请或自动发布案例推广内容。

证据包完整性不等于第三方来源认证；原始视频仍需要原 Robot Reel 数据包及其 NOTICE。合成 Blender 场景不代表测量得到的工厂孪生。
