# Amazon Bedrock AgentCore（arm64 自带容器）

沙箱和执行 Agent 都以自带容器的方式运行在 Amazon Bedrock AgentCore Runtime 上，区域为东京（ap-northeast-1）。两个镜像均为 linux/arm64，由 CodeBuild 在 arm64 机器上原生构建，不经模拟器。工作台可以把生成代码和 AI 调用交给它们执行：本机不需要 bubblewrap、执行器、账本或 Kiro 密钥。

## 为什么拆成两个镜像

AgentCore 对镜像大小有 2 GB 的硬上限，不能申请提高，而 amd64 单一镜像约 7 GB，装不进去。因此按职责拆成两个只做一件事的镜像，并且互不共享权限：

| 运行时 | 镜像（压缩后） | 内容 | 网络 | 凭据 |
|---|---|---|---|---|
| `pai_cad_sandbox` | 约 0.42 GB | CadQuery 2.8 / OCP 7.9（精简哈希锁，13 个包）、共用原生检查、bubblewrap | 隔离子网：无 NAT、无 IGW，只能访问拉取镜像和写日志所需的端点 | 无 |
| `pai_kiro_agent` | 约 0.55 GB（解压后 1.34 GB） | Node LTS、执行器锁定的 Kiro CLI（aarch64）、NoteFlow 执行器（版本见 `tools/runtime-pins.json`） | 私有子网经 NAT 出网（访问 Kiro 服务和 Secrets Manager） | 每次调用时从 Secrets Manager 读取 Kiro 密钥 |

两个镜像都不含 Blender，因为 Blender 官方没有 linux-arm64 版本，而且这两项工作也不需要它。

精简锁 `native/cadquery-runtime-requirements.txt` 由 `tools/slim_cadquery_lock.py` 生成：
- 生成方式：用 `-X importtime` 跑一遍所有原生 CAD 入口（预设、扫描、沙箱执行、生成件测量、STEP 重导入），统计实际导入的包，再把这些包的条目连同原始哈希从完整锁里原样复制出来，不重新解析依赖。
- 去掉的包：scipy、numba/llvmlite、matplotlib、trame。它们出现在 cadquery 声明的依赖里，但 PAI 的代码路径从不导入。
- 一致性：用精简环境和完整环境分别跑 4 个预设、扫描、沙箱代码、生成件测量和 STEP 重导入，结果逐值相同。
- 防过期：`--check` 会在精简锁需要重新生成时报错。

## 隔离

**沙箱运行时**
- 每个任务使用新的 `runtimeSessionId`，也就是一台新的 microVM。同一会话里已经跑过任务的，再提交会返回 409。
- microVM 内依次执行：AST 策略 → 进程锁定（rlimit、审计钩子、受限内置函数）→ bubblewrap。
- AgentCore 的内核允许非特权用户命名空间，实测 bubblewrap 可以启用；无法启用时，响应会如实报告该层未启用。
- 沙箱运行时只有拉取自身镜像和写日志的权限，没有任何密钥。在 bubblewrap 内，代码还会被清空环境变量并切断网络命名空间。
- 工作台启动时会做一次真实探测：只有探测结果同时满足“存在 microVM 边界”和“无法访问互联网”，才启用远端沙箱，否则拒绝。

**执行 Agent 运行时**
- 只处理文本提案，只开放 Kiro 三个账号。
- 尝试账本和每次运行的回执都放在加密的 EFS（保留策略）上，挂载为 `/mnt/ledger`，访问点固定 uid 1001、目录权限 0700。因此新建会话或更新运行时版本都不会重置额度。
- 账本只能通过显式操作 `init-ledger` 创建一次，策略见 `tools/agentcore-ledger-policy.json`：只限 Kiro，单次运行最多 3 次尝试，每天 10 次。已有账本不会被替换。
- 相同 `run_id` 在新会话中重复提交，会返回已保存的答案，不会再次调用引擎。

**调用与日志**
- 两个运行时只接受 IAM（SigV4）授权的调用。
- 服务端只记录请求路径和状态码，不记录请求体、代码、提示、答案或密钥。

## 网络

所有资源放在独立的 VPC `10.80.0.0/16` 里，不改动 WordPress 所在的 VPC。

| 子网 | 路由 | 用途 |
|---|---|---|
| 公有（2 个可用区） | IGW | NAT 网关 |
| agent（2 个可用区） | NAT | Kiro 执行器、EFS 挂载点 |
| sandbox（2 个可用区） | 只有 VPC 本地路由，外加 S3 网关端点（只允许读取 ECR 镜像层） | CAD 沙箱、ECR/日志接口端点 |

安全组规则：
- 沙箱只允许出站访问接口端点（443）和 S3 前缀列表（443）。
- Agent 允许出站 443，以及访问 EFS 的 2049。
- EFS 只接受来自 Agent 的入站连接。

## 部署与运维

```bash
python3 tools/package_executor.py && python3 tools/package_agentcore.py   # 构建上下文（执行器源码不进 Git）
cd infra && npx cdk deploy PAIAgentCoreBase                                # VPC、EFS、ECR、arm64 CodeBuild
cd .. && python3 tools/agentcore_operator.py build                         # 原生 arm64 构建并推送（标签不可覆盖）
cd infra && npx cdk deploy PAIAgentCoreRuntime -c agentcoreImageTag=<ImageTag>
cd .. && python3 tools/agentcore_operator.py invoke --runtime agent --payload '{"op":"init-ledger"}'   # 只需一次
python3 tools/agentcore_operator.py invoke --runtime sandbox --payload '{"op":"probe"}'
```

工作台接入方式：设置 `PAI_AGENTCORE_SANDBOX_ARN` 和/或 `PAI_AGENTCORE_AGENT_ARN`，并提供可以调用这两个运行时的 AWS 凭据（默认凭据链）。
- 设置了 Agent 而没有配置本地执行器时，AI 请求改由 AgentCore 执行。远端报告与本地报告经过同一套校验。
- 设置了沙箱后，生成代码改由 AgentCore 执行。返回的文件先核对 SHA-256，再进入本地的基准对照、EvalArc、反馈和发布流程。
- 调用超时或返回非 2xx 时，结果一律标记为待核对，不会自动重试；SDK 的重试也已关闭。

## 费用

运行时按实际会话计费。固定开销主要来自 NAT 网关（东京约 45 美元/月，另加流量费）和 3 个接口端点（单可用区，约 31 美元/月）；EFS、ECR 和 CodeBuild 的费用很小。具体金额请以 AWS Pricing Calculator 为准。

删除 `PAIAgentCoreRuntime` 和 `PAIAgentCoreBase` 两个栈即可停止这些费用。EFS 账本和 ECR 仓库设置了保留，删除栈后仍会保留，需要另行处理。

## 验证

见 [回执](evidence/agentcore.json) 和 [工作台联调](evidence/agentcore-live.json)：
- 沙箱：模板结果与预设 reference 逐项相同；2.5 mm 板厚判为 min-wall 失败；`import socket` 在执行前被拒绝；死循环 60 s 后被终止；同一会话再次提交返回 409。
- 跨架构：arm64 上的质量和各项实测值与 amd64 相同。
- 联调：本机工作台在没有执行器和密钥的情况下，经 AgentCore 完成一次真实 Kiro 调用（主账号完成，生成 1 个 cad-code 计划），确认后该代码在 AgentCore 沙箱中建模并通过全部检查。
- 账本：在新会话中重放同一 `run_id`，执行器返回已保存的答案，额度不变；运行时版本更新后，账本中已完成的尝试仍是 1。
- 共消耗 1 次真实尝试。

## Visual review over AgentCore

`text-proposal` accepts optional `images` (at most 3, each ≤ 1.5 MB): `{media_type, sha256, data}` with base64 data.
The runtime decodes each image and checks its size, PNG/JPEG magic bytes and digest. It then writes the image privately
into the run directory and passes it to the pinned executor by path and digest. Reusing a `run_id` with other images is
refused (`RUN_ID_REUSED`). Verified live with the blind line-of-sight control: 6/6, see [VERIFICATION.md](VERIFICATION.md).

