# 主流工业设计软件界面与交互对比

2026-10-01 查阅各厂商官方帮助与产品资料，提炼专业工具共有的界面与流程模式，与本工作台逐项对照。这里只比较界面与流程的组织方式，不比较几何内核、求解器或授权能力；厂商的效率说法没有复测。

## 共有模式

| 模式 | Onshape | Fusion | SOLIDWORKS / 3DEXPERIENCE | NX / Teamcenter | CATIA 3DEXPERIENCE | Creo | Blender |
|---|---|---|---|---|---|---|---|
| 左侧模型/历史树 | Feature list 与 Rollback bar | Browser | FeatureManager 设计树 | Part Navigator | 规格树 | Model Tree | Outliner |
| 中央视口 + 视图立方 | Graphics area | Canvas + ViewCube | 图形区 + 视图定向 | 图形窗口 | 3D 区 + Compass | 图形区 | 3D Viewport |
| 上下文命令区 | 按 Part Studio/装配/图纸切换工具栏 | 按 Workspace 切换工具栏 | CommandManager 按文档类型分页 | Ribbon | Action Bar | Ribbon + Mini Toolbar | 按 Workspace 切换编辑器 |
| 属性/命令对话框 | Dialog（蓝色字段表示需要选择） | Dialog | PropertyManager（确认/取消） | 对话框 | 面板 | 操控板 | Properties / N 面板 |
| 历史与时间轴 | Versions & history，可比较、可分支 | 底部 Timeline + Version History | 修订 | 修订 | 修订 | 修订 | Timeline（动画） |
| 版本与成熟度 | 不可变 Version；Release candidate 审批后 Released | 版本 | In Work → Frozen → Released → Obsolete；Change Action | 修订 + Data Release 工作流 + 变更管理 | 成熟度 + Change Action | Windchill 生命周期 | 无 |
| 后台任务与状态 | 通知 | Job Status、Notification Center | 状态栏 | 状态行 | 状态栏 | 消息区 | Status Bar（快捷键、消息、统计） |
| 搜索命令 | Search tools | 搜索 | 命令搜索 | 命令查找器 | 搜索 | 命令搜索 | F3 搜索 |
| AI 助手 | — | Autodesk Assistant | Aura / AI 助手（视版本） | — | — | — | — |

资料来源：[Onshape 界面基础](https://cad.onshape.com/help/Content/Home/user_interface_basics.htm)、[Onshape 版本与分支](https://cad.onshape.com/help/Content/versionmanager.htm)、[Onshape 发布管理](https://cad.onshape.com/help/Content/release_management.htm)、[Fusion 界面](https://help.autodesk.com/view/fusion360/ENU/?guid=GS-THE-FUSION-INTERFACE)、[SOLIDWORKS 管理面板](https://help.solidworks.com/2015/English/SolidWorks/sldworks/c_management_panel.htm)、[3DEXPERIENCE 成熟度状态](https://blogs.solidworks.com/products/solidworks/3dexperience-works-lesson-4-solidworks-and-lifecycle-maturity-states/)、[Teamcenter 数据发布](https://blogs.sw.siemens.com/designcenter/nx-tips-and-tricks-data-release/blog_header_data_release/)、[Blender 状态栏](https://docs.blender.org/manual/en/latest/interface/window_system/status_bar.html)。

## 结论：哪些借鉴，哪些不照搬

本工作台不是建模软件，而是绑定证据的设计评审工作台。所以借鉴的是这些工具的**组织方式**：树、视口、属性、历史、成熟度、任务状态。不照搬它们密集的建模命令区。

| 专业模式 | 本工作台对应 | 本轮状态 |
|---|---|---|
| 模型/历史树 | 视口大纲（Outliner）+ 构建阶段时间轴 | 已有 |
| 视口 + 视图预设 | three.js 视口：透视/顶/前/右/检查相机、线框、X 光 | 已有 |
| 上下文命令区 | 生命周期阶段栏 + 每个阶段只显示该阶段的操作；Ctrl+K 命令搜索 | 已有 |
| 属性面板 | 每条证据通道的专业参数表单；AI 计划可“在专业面板调整” | 已有 |
| 不可变版本 + 比较 | 需求修订只能新建版本，**但旧版本内容会被覆盖、无法比较** | **补齐**：保存每个需求版本快照，显示版本历史与逐项差异 |
| 发布与成熟度 | 有“交付试用”，**但没有发布关卡，也没有成熟度状态** | **补齐**：发布候选 → 审批 → 已发布 / 已驳回；需求变化后自动变为“已废止”；发布前自动检查准入条件 |
| 版本比较 | 每次运行内有基准 vs 候选，**但不同候选之间无法并排比较** | **补齐**：同类证据的检查矩阵并排比较 |
| 任务状态栏 | 只有顶部进度条与通知 | **补齐**：底部状态栏，显示运行中原生任务、需求版本与哈希、成熟度、连接状态与快捷键 |
| AI 助手 | 停靠侧栏；类型化计划，标出放宽；需确认后执行 | 已有；比 Fusion/SOLIDWORKS 的助手多一层“计划无验收权” |
| 浅色/深色主题 | 跟随系统 / 浅色 / 深色（顶栏切换，记住选择）；视口始终深色 | **0.8.0 补齐**：两种主题都通过 WCAG 2.1 AA 对比度检查（axe-core） |
| 中央命令框 | Onshape/Figma 式顶栏搜索框：搜索命令、跳转；输入的不是命令时，就把它当作问题交给 AI 助手 | **0.8.0 补齐** |
| 可收起的工具栏 | 生命周期侧栏可收起为图标栏，`[` 键切换，记住状态 | **0.8.0 补齐** |
| 检查结果面板 | 参照 Fusion/Onshape 的制造检查与干涉面板：每条规则列出实测值、要求和余量条，未通过的行高亮 | **0.8.0 补齐**（CAD） |
| 在证据处问 AI | 参照 Fusion Assistant、NX Design Copilot 的“解释这个”：每个未通过的检查旁边都有“问 AI”，自动带上实测值和要求；提问前切换到 AI 引擎，回答必须引用记录 | **0.8.0 补齐**（四条通道） |
| 视口优先的验证工作区 | 工作区较窄时，检查记录变成横向条带，视口留在首屏上半部分；执行记录在完成后折叠 | **0.8.0 补齐** |
| 桌面端 | 与 VS Code、Figma、Claude 桌面版相同，采用 Electron；原生菜单、单实例运行、可一键安装原生工具 | **0.8.0 补齐**，见 [DESKTOP.md](DESKTOP.md) |

## 准入条件为什么这样定

参照 Onshape 的发布候选和 3DEXPERIENCE 的 Change Action：发布对象必须是一次已完成、结论为通过的检查，且绑定当前需求版本；项目里所有保留的失败案例都要有已关闭的反馈；不能有未关闭的反馈。发布只是记录“在该证据范围内采用此设计决策”，不代表物理验证、量产放行或安全认证。审批人是当前登录的维护者，系统不会自动发布，也不对外发送任何内容。
