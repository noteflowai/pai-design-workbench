# PAI Design Workbench

TypeScript 专业设计工作台：**需求 → 候选设计 → 原生验证 → 失败回放 → 反馈复测 → 可核验交付与试用反馈**。

首个可运行场景是机器人实验设计评审。Radar 提供专业线索，领域适配器连接 Robot Reel 的真实记录核验与 EvalArc 的独立检查项对照，现有 NoteFlow 控制器保留模型预算、路由和恢复职责。

已实现**历史记录评审**与 **Blender 原生静态场景设计**两个闭环，提供响应式 Web/PWA。首版不执行新的策略推理，不包含参数化机械 CAD、现场安全认证或自动发布。受控模型提案接口已实现，但实际模型调用需要现有控制器入口与经过审查的预算账本；未配置时明确禁用。

## 快速启动

要求 Node.js ≥24.21（当前最新 LTS）、npm、Python ≥3.12、Git。

```bash
npm ci
npm run setup:demo    # 下载固定版本的公开工具及原始仿真记录，约45MB记录
npm run setup:native  # Linux x86_64：最新 Blender 5.2.2 LTS，官方校验和验证
npm run check
npm run test:native
npm run test:blender
npm run start        # http://127.0.0.1:4317
```

在本工作区直接使用相邻的 `robot-reel`、`evalarc`、`physical-ai-radar` 和 `noteflow-agent-control`，可省略 `setup:demo`。安装脚本只使用本仓库 `.state/deps`；如果既有依赖版本或工作区变化，停止并保留它们。

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

[云端 CI 已通过](https://github.com/noteflowai/pai-design-workbench/actions/runs/36716935336)：最新 Node LTS 验证完整原生与浏览器链路，最新 Current 验证构建、边界测试和原生记录闭环。详见报告中的环境与范围。

![Blender 原生场景与反馈复测工作台](docs/evidence/blender-desktop.png)

## 工具边界

| 环节 | 实现与职责 |
|---|---|
| 专业研究 | Radar 原始快照、来源链接、来源自报等级与日期；不直接决定验收 |
| 领域设计 | 冻结需求、比较条件；Blender 原生场景、射线/投影与几何检查；参数化 CAD/动力学待接入 |
| 运行控制 | NoteFlow 原生 text-proposal flow；使用既有预算账本，不初始化或重置预算 |
| 原生验收 | Robot Reel 核验记录与配对统计；生成稳定种子 ID 的 JUnit，交由 EvalArc 对照 |
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

服务绑定 loopback，拒绝外部 Host 与跨源写入，面向单人本地使用。没有多租户认证、云部署或匿名公开上传功能。

## 开发

```bash
npm run typecheck
npm test
npm run build
npm run test:native
npm run test:browser
```

TypeScript 7.0.2 与当前稳定依赖锁定在 `package-lock.json`。Node 24.21 LTS 与 26.10 Current 在 CI 检查；Blender 5.2.2 使用官方校验和验证。原生依赖固定在安装脚本中，升级需要重新通过原生和浏览器检查。

- [系统设计与取舍](docs/ARCHITECTURE.md)
- [API 与闭环操作](docs/API.md)
- [后续领域接入和试用计划](docs/NEXT.md)
- [主流工业软件与开源方案](docs/INDUSTRIAL_SOFTWARE.md)
- [多端与最新版本策略](docs/MULTIPLATFORM.md)

本仓库新代码使用 MIT；Robot Reel 派生测试数据保留 Apache-2.0 与原始 NOTICE。见 [第三方说明](THIRD_PARTY_NOTICE.md)。
