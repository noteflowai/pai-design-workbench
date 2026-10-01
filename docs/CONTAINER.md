# 单一镜像与多端运行

## 结论

服务端统一用一个 OCI 镜像 `pai-workbench`，内含：工作台、NoteFlow 受控执行器（acpx 0.19.3，提交 `ec007f0`）、Kiro CLI 2.24.0、Codex/Claude ACP 适配器、Blender 5.2.2 LTS、CadQuery 2.8 / OCCT 7.9、bubblewrap 和已固定版本的演示证据。浏览器端本来就是 Web/PWA，各种设备直接访问，不需要镜像。

托管站点 pai.oneai.host 没有改成在 EC2 上运行镜像：根卷只有 16 GiB，而镜像约 7 GB，迁移的风险和收益不成比例。托管站点直接在主机上安装，但与镜像使用同一份版本清单 `tools/runtime-pins.json` 和同一个安装脚本 `tools/install_ai_runtime.py`，两边的组件版本完全一致。

| 组件 | 固定方式 |
|---|---|
| Ubuntu 24.04 | 基础镜像摘要 |
| Node.js 24.21.0 | 官方 SHA256SUMS |
| Blender 5.2.2 | 官方 sha256（只有 linux-x64） |
| CadQuery 2.8.0 | `native/cadquery-requirements.txt` 中的哈希锁 |
| Kiro CLI 2.24.0 | 官方带版本号的下载地址，SHA-256 已记录；x86_64 版与本机已验证的二进制逐字节相同 |
| 执行器 | 私有仓库指定提交的 `git archive`，摘要已固定；源码不进入本仓库，由 `tools/package_executor.py` 打包到被忽略的 `.state/deploy` |

## 构建与运行

```bash
python3 tools/package_executor.py
docker build --build-context executor=.state/deploy --build-arg PAI_UID=$(id -u) -t pai-workbench:0.4.0 .
docker run -d --name pai --network host \
  -e PAI_CONTROLLER_DATABASE=/ledger/ledger.sqlite3 -e PAI_AI_PROFILES=kiro-primary,kiro-backup,kiro-backup2 \
  -v pai-data:/data -v ~/.local/state/pai-design-workbench/budget:/ledger \
  -v ~/.config/agent-cli/env:/home/pai/.config/agent-cli/env:ro \
  -v ~/.config/kiro-failover:/home/pai/.config/kiro-failover:ro \
  pai-workbench:0.4.0
```

- **凭据只在运行时挂载，从不写入镜像。** 镜像里没有任何密钥；`docker history` 中也没有。
- **账本必须是经过审查的已有账本。** 镜像不会创建或重置账本。
- **用 `PAI_AI_PROFILES` 限定本部署可用的引擎。** 例如只挂载了 Kiro 凭据，就只开放 Kiro 三个账号。
- **Codex 和 Claude 依赖个人登录与 Bedrock 配置。** 只在本机挂载 `~/.codex`、`~/.claude` 时启用。它们是否产生原生影响无法核实，结果会进入“待核对”。

## 平台

| 平台 | 状态 |
|---|---|
| linux/amd64 | 已构建并实测：容器内 Blender 5.2.2 原生场景（带遮挡方案被 camera-visibility 拒绝，无遮挡方案通过，生成 .blend/GLB/PNG），CadQuery 原生检查得到预期的 min-wall 失败，Kiro 主账号回答并附引用，计划通过 schema 校验 |
| linux/arm64 | Node、Kiro、CadQuery 都有对应版本；Blender 官方没有 linux-arm64 版本，镜像中会缺少 Blender 通道。未构建 |
| macOS / Windows | 通过 Docker Desktop 运行 amd64 镜像；不打包原生桌面应用 |

## 托管站点的 AI

- Kiro 的三个无头 API 密钥由 `python3 tools/aws_operator.py put-ai-keys` 从本机密钥文件读取，写入 Secrets Manager 的 `pai-workbench/kiro-keys`，终端不显示任何值。
- 发布时 `infra/install_ai.sh` 以 `pai` 用户身份安装固定版本的组件，把密钥写成仅属主可读写（0600）的文件，并按 `tools/ai-ledger-policy.json` 创建独立账本（只限尝试次数，每天 20 次）。已有账本只复用，不替换。
- 托管站点只开放 Kiro 主账号 → 备用账号 → 二备账号。
