# 主流工业设计软件与 AI 结合：分析对比

2026-10-01 查阅厂商官方资料与公开论文。“快 70%”“提速 10–100×”“自动生成 80% 视图”等数字均为厂商自报，未经复测。第三方评测若来自竞品（如 Leo AI），已注明。

## 结论

主流工业设计软件的 AI 可分为五层，成熟度差别很大：

1. **知识问答**：已普遍正式提供，如 Autodesk Assistant、AURA、Onshape AI Advisor、Creo AI Assistant。
2. **预测与小任务自动化**：已正式提供，也是价值最明确的一层，如自动出图、自动约束、选择预测、命令预测、自动刀路。
3. **生成设计与仿真代理模型**：已正式提供，以物理为依据，如 Fusion 生成设计、Ansys SimAI / GeomAI、Altair physicsAI。
4. **对话执行智能体**：多数处于预览或早期试用。Autodesk 下一代 Assistant 的上线时间要到 2027 年公布；Onshape 的 FeatureScript MCP 在 Labs 中试用；3DS 虚拟伙伴已在 3DEXPERIENCE SaaS 正式提供。
5. **开放给外部智能体**：MCP 快速成为通用接口，如 Fusion MCP、Fusion Data MCP、Onshape FeatureScript MCP、Autodesk 文档 MCP，以及 Blender 社区的 MCP。

所有厂商都把 AI 定位为“伙伴，不是自动驾驶”，由人来确认。

## 各厂商现状

| 厂商 / 产品 | 已正式提供 | 预览 / 早期试用 | 能否直接操作模型 |
|---|---|---|---|
| Autodesk Fusion | Assistant；自动出图、AutoConstrain、生成设计、自动刀路；Fusion MCP（把运行中的会话变成 MCP 端点）与 Fusion Data MCP | 下一代跨产品智能体（Assistant Spaces、Assistant Builder，2027 年公布上线）；Neural CAD 可用状态未核实 | 能，通过 MCP |
| SOLIDWORKS / 3DEXPERIENCE / CATIA | AURA、LEO、MARIE 虚拟伙伴（2026-07 起在 SaaS 正式提供，19 项能力）；R2026x FD04 新增提示词库、自动展开、自动爆炸视图 | 生成式虚拟孪生、Virtual Twin Factories | 部分能，需要上云平台。竞品评测认为桌面版 AURA 主要是文档问答 |
| Siemens NX / Solid Edge | Design Copilot（基于 Phi-3，可对话修改设计）；命令/选择预测、相似选择、PMI 预测、以图找零件、语音；Solid Edge 自动生成最多 80% 的视图 | — | 部分能 |
| PTC Onshape / Creo | AI Advisor（基于 Bedrock，按文档回答）；FeatureScript 补全；Creo 13 AI Assistant | FeatureScript MCP Server：AI 生成、运行并修正自定义特征代码 | 能，生成可复用的参数化代码 |
| Ansys / Altair / Siemens 仿真 | SimAI Pro/Premium、GeomAI；physicsAI；Simcenter PhysicsAI | — | 不改模型，用历史求解数据做预测 |
| 新兴公司 | Zoo（自研内核与 KCL，Zookeeper 智能体可检查、快照、调试几何）；Adam（输出参数化代码）；Leo AI（工程问答） | — | Zoo 能 |
| Blender | 社区 MCP，部分提供确定性校验与稳定的工具接口 | — | 能，安全边界取决于实现 |

来源：[Autodesk AU 2026](https://adsknews.autodesk.com/en/pressrelease/autodesk-advances-agentic-ai-in-its-three-industry-clouds/)、[Fusion MCP](https://help.autodesk.com/view/fusion360/ENU/?guid=FMCP-OVERVIEW)、[Dassault 虚拟伙伴](https://www.3ds.com/newsroom/press-releases/dassault-systemes-expands-3dexperience-ai-native-agentic-platform-new-virtual-companion-skills-co-engineer-humans)、[SOLIDWORKS AI R2026x FD04](https://blogs.solidworks.com/products/solidworks/ai-purpose-built-for-the-way-engineers-work-whats-new-in-solidworks-ai-r2026x-fd04/)、[Siemens Designcenter AI](https://www.siemens.com/en-us/products/designcenter/nx-cad-software/ai/)、[Onshape FeatureScript MCP](https://www.onshape.com/en/blog/featurescript-mcp-server-enables-text-code-cad)、[Creo 13](https://www.ptc.com/en/news/2026/ptc-brings-ai-powered-guidance-to-the-design-environment-with-creo-13)、[Ansys SimAI](https://www.ansys.com/fr-fr/products/ai/simai)、[Zoo Zookeeper](https://docs.zoo.dev/research/zookeeper)。

## 学术界对“文字生成 CAD”的实测

- [Text2CAD-Bench](https://arxiv.org/abs/2605.18430)（600 个人工整理的样例）：
  - 基础几何尚可，例如 GPT-5.2 在 L1 的 IoU 为 0.59、失败率 11%。
  - 高级特征（扫掠、放样、抽壳）的代码失败率普遍为 70–90%。
  - 输出 CadQuery 代码明显优于输出命令序列。
  - 能执行、几何准、符合设计意图三者基本独立，没有一个模型同时做好。
- [MUSE](https://arxiv.org/abs/2605.28579)：装配体评测中失败层层递进，从“代码能跑”到“几何有效”再到“工程可用”。
- [CADSmith](https://arxiv.org/abs/2603.26512)：加入程序化几何校验回路后，中位 IoU 从 0.81 提高到 0.96。生成后必须有校验闭环。

## 横向比较

| 维度 | 行业现状 | 趋势 |
|---|---|---|
| AI 的形态 | 问答 → 预测 → 生成与代理模型 → 执行智能体 | 从回答走向执行 |
| 依据从哪来 | 文档、社区、项目与历史数据 | 争夺项目上下文 |
| 由谁执行 | 原生内核，AI 发出指令或代码 | 生成可复用的参数化代码 |
| 集成方式 | MCP | 开放给外部智能体与企业自有工具 |
| 结果如何验证 | 多依赖人工审阅 | 程序化几何校验闭环 |
| 数据与主权 | 主权云、Bedrock、Phi-3 | 对知识产权与部署位置的要求提高 |

## 本工作台的差距与补齐方案

本工作台已经做到：AI 只生成类型化计划、确认后由原生工具执行、EvalArc 独立对照、失败案例保留、发布需要准入检查与人工批准。下列差距按本轮实现顺序排列。

| # | 差距 | 补齐方式 | 边界 |
|---|---|---|---|
| 1 | 没有基于证据的问答 | 助手按已保存的记录回答“为什么拒绝、哪些失败、下一步、能否发布”，每句话附记录引用 | 确定性检索，不编造；找不到依据时如实说明 |
| 2 | 没有接入大模型 | (a) MCP 接口：用户自己的 AI 客户端（Claude、Codex 等）提供模型；(b) 控制器规划器：配置控制器与已审查的预算账本后，模型输出的计划经同一套 schema 校验 | 模型没有验收或发布权；未配置时不调用；不新建、不重置预算账本 |
| 3 | 没有开放 MCP | 本地 stdio MCP 服务器：读取状态与证据、查询准入、提交计划（必须在界面确认）、在沙箱中试跑 CAD 代码 | 没有批准、发布、推进反馈的工具；托管站点需要 Cognito 登录，MCP 只连接本地工作台 |
| 4 | CAD 只有固定零件族 | “文字 → CadQuery 代码 → 沙箱执行 → B-Rep 校验 → 反馈修正”通道 | 多层沙箱：AST 白名单、审计钩子、资源上限、bubblewrap 命名空间隔离（无网络、只读文件系统） |
| 5 | 没有设计空间探索 | 对参数化支架做真实的原生参数扫描，给出质量与约束的权衡前沿 | 每个点都是原生 B-Rep 评估，不是代理模型；仍不含 FEA |

不做：仿真代理模型。没有真实求解数据时只能是演示，与“不制造证据”的原则冲突。
