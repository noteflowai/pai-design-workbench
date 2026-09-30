# Robot Reel 最新进展与 PAI 接入

2026-09-30 复核远程主分支与本地提交，均为 `b3ee5c7d2c5588ddc7e067869c049aad7e6951ce`，PR [#90](https://github.com/noteflowai/robot-reel/pull/90) 新增 Factory Twin Lab。[v0.18.0 已发布](https://github.com/noteflowai/robot-reel/releases/tag/v0.18.0)，上游 Check/Release 均成功；[公开演示页](https://noteflowai.github.io/robot-reel/factory-twin/)返回 200，内容与复验副本一致。本轮检查保留原工作区未提交的推广笔记和封面，没有重置、合并或覆盖 Kiro 的工作。检验使用该提交的独立归档副本。

新增能力包括六工位产线、三台 AMR、园区温控与能源仿真；带噪声、丢包、延迟的遥测；主轴磨损 EKF；14 种维护候选预测；需量控制和延迟执行；同扰动的 closed/shadow 配对；Blender 程序化园区、记录驱动动画、OpenUSD 导出与回读。参见[原始方法与限制](https://github.com/noteflowai/robot-reel/blob/b3ee5c7d2c5588ddc7e067869c049aad7e6951ce/examples/factory-twin/METHODS.md)。

## 独立复核结果

| 检查 | 本轮实际执行 |
|---|---|
| `factory-twin --verify --all-seeds` | 全部 12 组配对重执行；featured seed 的 plant/twin 与遥测独立回放一致，每条记录 2,161 个样本 |
| `test_factory_twin.py` | 17 项通过，包括一致但被修改的记录、文件摘要、重复 JSON 键、符号链接、输入回执、遥测依赖与执行延迟 |
| 离线浏览器 | 1440/390/320px 通过：两个模式、决策跳转、分享位置恢复、逐样本 CSV、播放暂停、无联网请求与无脚本错误 |
| Blender/OpenUSD | 复制本地已生成的原生包至私人验证目录，核对 14 个文件、原生文件摘要及脚本来源；用 Blender 5.2.2 LTS 独立重开两个 `.blend`，各核对 313 通道 × 2,161 帧，并分别重新导出、回读 USD。全部通过，原文件未修改 |

[脱敏复核记录](evidence/robot-reel-factory-review.json)区分本轮执行与上游报告。本轮共核对 1,352,786 个动画通道值及两个模式的 2,161 帧 USD 变换；没有重新建模或渲染。12 个种子中产出改善 10 对、退化 2 对，不能只展示 seed 10 的正面结果。所有参数与成本权重是演示设定，未校准真实工厂；Blender 是记录驱动动画，没有执行动力学。

发行交付仍有一个缺口：本轮核对时，文档链接 `releases/latest/download/factory-twin-blender.zip` 返回 404，v0.18.0 的公开附件列表缺少该包；3.39 MB 的本地原生包已核验可用。没有修改外部发行附件或 Kiro 的发布流程。公开交付需补齐该包并复核下载摘要，不能把 CI 成功当成所有下载入口均可用。

## 接入分工

Factory Twin 使 Robot Reel 同时提供演示仿真、回放与证据交接。专业任务、需求版本、候选方案与反馈仍由 PAI 管理；Radar 提供工业来源；NoteFlow 管理执行预算和恢复；EvalArc 独立比较验收约束。上游生成或自校验不能直接赋予工作台“验收通过”。

| 接入环节 | 需要绑定的证据 |
|---|---|
| 设计与预测 | 需求版本、参数/成本权重摘要、候选计划、遥测年龄、决策时间与预测结果 |
| 验证 | 每个 seed 的配对产出、故障、需量、舒适约束及退化案例；事先冻结通过标准 |
| 原生交付 | `.blend` / `.usdc`、输入摘要、实际重开与 USD 回读；区分上游回执和本地执行 |
| 推广 | 案例草稿保留全部种子表、方法和限制；合成仿真明确标注来源 |
| 反馈闭环 | 失败 seed、约束、期望/实际绑定原始请求；修复以新参数版本重执行后关闭 |

下一项产品能力优先选择“维护与能源方案评审”，复用已存在的仿真与证据格式，先提供只读导入与独立约束比较，再扩展受控参数运行。输入需要显式标记 `illustrative-simulation`，对产出退化、EV 服务量和舒适度设置约束；不能把能源降低直接计为综合改善。

当前线上仍使用已完成原生闭环验证的 Robot Reel `6124cee3cba5`。升级应在独立工具目录锁定新提交，完成原有记录工作流回归、Factory Twin 原生交付复核和输入边界检查后发布；旧记录保留原版本、原文件和原回执。真实 PLC/设备控制、现场收益和安全验证尚未实现。
