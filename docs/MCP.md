# MCP 服务器

`pai-mcp` 是一个 stdio MCP 服务器（官方 SDK 1.31.0，协议 2025-11-25）。外部 Agent（Kiro、Claude Code、Codex 等）可以通过它读取工作台的有据视图并提议计划。它只是本机工作台 HTTP API 的客户端：工作台仍是唯一写入方，每个提议都按应用内 AI 引擎使用的同一套契约、收紧/放宽判断和引用检查来校验。

## 工具

| 工具 | 作用 | 只读 |
|---|---|---|
| `pai_list_projects` | 列出任务、需求版本、生命周期阶段和下一步 | 是 |
| `pai_get_workspace` | 返回带句柄的记录（`cad-1`、`scene-2`、`feedback-1`、`version-1`…）、失败案例、生命周期，以及可提议工具的 payload JSON schema | 是 |
| `pai_get_record` | 按句柄读取完整记录：原生检查、实测值、回执 | 是 |
| `pai_get_admission` | 某条检查能否作为发布候选（只读，不会创建发布） | 是 |
| `pai_list_versions` | 只追加的需求版本与需求哈希 | 是 |
| `pai_propose_plan` | 把类型化计划放进工作台 AI 助手，等待维护者确认 | 否，但不执行任何操作 |
| `pai_get_plan` | 查看计划是否已被确认执行，以及产生的记录 | 是 |

刻意不提供的能力：确认或执行计划、启动原生任务、推进反馈、核对 AI 运行、创建或批准发布。这些都只能由维护者在工作台中完成。

提议的校验与 `/api/assistant/ai` 完全一致：
- payload 不符合 schema 或工具未知的计划会被拒绝，并说明原因；
- 放宽冻结约束的计划会被标出，并附警告；
- 引用了不存在的句柄时，整个提议返回 `INVALID_CITATION`；
- 没有任何有效计划时返回 `NO_VALID_PLAN`；
- 传入相同的 `requestId` 重试不会产生重复提议。

提议在助手中显示为“外部 Agent · 客户端名称 · 经 MCP · PAI 未调用模型”，权限为无。

## 使用

先启动工作台（`npm run start`），再执行 `npm run build`。`PAI_URL` 只接受本机回环地址（默认 `http://127.0.0.1:4317`），所以服务器不会把工作区数据发往其他主机。`PAI_MCP_AGENT` 可以指定显示名称，默认使用客户端在 initialize 时报告的名称。

Kiro CLI（`.kiro/settings/mcp.json` 或 `~/.kiro/settings/mcp.json`）：

```json
{ "mcpServers": { "pai": { "command": "node", "args": ["/absolute/path/pai-design-workbench/dist/src/mcp.js"],
  "env": { "PAI_URL": "http://127.0.0.1:4317" } } } }
```

Claude Code：

```bash
claude mcp add pai -e PAI_URL=http://127.0.0.1:4317 -- node /absolute/path/pai-design-workbench/dist/src/mcp.js
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.pai]
command = "node"
args = ["/absolute/path/pai-design-workbench/dist/src/mcp.js"]
env = { PAI_URL = "http://127.0.0.1:4317" }
```

## 范围与安全

- **只支持本机。** 托管站点 pai.oneai.host 需要通过 ALB/Cognito 登录，`pai-mcp` 不连接远程站点。远程 MCP 需要 HTTP 传输加 OAuth，属于另一项设计。
- **不增加权限。** 本机工作台绑定回环地址，与原来一样，本机进程本来就能访问它的 API。MCP 只开放读取和提议，不会让任何操作绕过维护者的确认。
- **工作区文本可能含注入内容。** 文本按数据原样返回，服务器的说明也提示 Agent 不要把它当作指令。被注入的 Agent 最多只能提议计划，而计划没有权限，必须经人工确认才会执行。

验证见 `tests/mcp.test.ts`：工具清单与只读标注、契约校验、引用、幂等和回环限制。另有浏览器流程：Agent 读取工作区并提议，维护者在界面确认后运行原生 CAD，Agent 再读到确认状态和拒绝结论。
