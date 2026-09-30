# AWS 部署：pai.oneai.host

部署目标是 WordPress 已使用的东京区域 `ap-northeast-1`、VPC `vpc-fb40619c` 和 `ai-srv-alb`。域名现有 CNAME 已指向该 ALB，HTTPS 使用现有 `*.oneai.host` 证书。本仓库只添加优先级 120 的主机路由，不修改 WordPress 的 100/110 路由、默认响应、HTTP 跳转或共享空闲超时。

2026-09-30 已完成实际部署和更新，入口为 [https://pai.oneai.host](https://pai.oneai.host)。管理员账号 `qiangguo`，密码通过下述 `login-file` 命令读取至私人文件。线上发布摘要为 `718b9be27766baddf54d72d6d4f6511d6557d43766cc48f26c19c3297edb061c`，运行代码提交 `1c0ae61dec98c8902eaaa7c24995e9ef2f27b75e`。[实际验收](VERIFICATION.md)包含 Cognito 登录、手机退出、真实原生任务、WordPress 200、旧路由逐项一致和服务重启持久化；快照恢复尚未演练。

## 运行架构

```text
浏览器 → 现有 ALB HTTPS → Cognito 登录 → 独立 EC2 工作台
                                     ├─ Node 24.21 LTS + Blender 5.2.2 LTS
                                     ├─ 加密 gp3 持久化卷：SQLite、原生文件与回执
                                     └─ AWS Backup：每日快照，保留 14 天
```

独立 `t3.medium`（2 vCPU / 4 GiB）运行单个工作台，持久化卷 40 GiB，系统卷 16 GiB。只有现有 ALB 安全组可以访问 4317，未开放 SSH；运维通过 SSM。实例公网地址仅用于出站安装和 AWS/登录签名公钥访问，不作为用户入口。

Cognito 禁止自助注册，初始管理员为 `qiangguo`；初始化使用 `MessageAction=SUPPRESS`，不会发送邮件或邀请。密码由 Secrets Manager 生成并保存于 `pai-workbench/admin`，不进入代码、实例环境或文档。应用用 `aws-jwt-verify` 验证 ALB 签名、签发者、客户端、过期时间和主体，拒绝只伪造身份头的请求。生产 Origin 精确限定为 `https://pai.oneai.host`。

长原生任务返回 `202`、`Location` 和稳定任务身份，浏览器轮询原回执。重复请求不重新执行，重启后运行中任务保留为 interrupted。此机制避免修改共享 ALB 的 60 秒空闲超时。

## 可复核部署

基础设施位于 [infra](../infra)。AMI 默认值固定到本次核对的 Ubuntu 24.04 amd64 发行版，可通过 CloudFormation 参数覆盖；AMI 升级可能替换实例，需要维护窗口和数据卷恢复流程。

```bash
npm ci
npm run check
npm run test:native
npm run test:browser
python3 tools/package_release.py
cd infra
npm ci
npm run synth
npm run diff -- --no-change-set
npm run deploy -- PAIDesignWorkbench
# 回到仓库根目录；新版本通过受控 SSM 切换
cd ..
python3 tools/aws_operator.py apply-release
```

部署包使用显式文件白名单，不包括 `.state`、数据库、提示词、私人控制器、浏览器会话或本地生成的证据。S3 上传包、Node 和 Blender 下载均验证 SHA-256。实例安装固定版本的公开依赖，不初始化模型预算账本。

管理员凭据与 SSM 运维使用该项目的最小范围 operator role：

```bash
python3 tools/aws_operator.py status
python3 tools/aws_operator.py login-file
```

第二条只将凭据写入被 Git 忽略的 `.state/deploy/admin-login.json`，权限为 0600；终端不打印密码。`send --script /path/to/reviewed-script.sh` 与 `result --command-id ID` 可用于明确授权的实例检查。不要在检查脚本中打印凭据。

## 持久化与更新

数据位于 `/var/lib/pai/data/state`，单进程 SQLite WAL 数据库及同一卷上的原生文件共同快照。删除栈保留数据卷、备份 vault、登录用户池和管理员 Secret。运行实例的 systemd 服务失败后重启，并保留任务身份；EC2 状态与 ALB 不健康目标有 CloudWatch 告警，未配置外发通知。

后续应用升级先验证并打包，再部署 CDK 中新的发布对象和精确 S3 读取授权，随后执行 `python3 tools/aws_operator.py apply-release`。脚本验证 SHA-256，在独立目录安装依赖、停止服务、原子切换 `/opt/pai/current` 并复核健康；失败时自动切回旧目录，不覆盖数据库或原生回执。原生工具版本更新另需重新验证和显式安装。

本环境的初始启动包固定在 `infra/cdk.json` 的 `bootstrapReleaseHash` / `bootstrapAssetKey`，不要随应用发布修改它们，也不要删除对应 S3 对象。这样前端更新不会因 EC2 UserData 变化而停止或替换实例；当前发布包由 `ReleaseHash` / `ReleaseKey` 输出指定。新建其他环境应选择经过验证的初始包。AMI/实例替换必须先确认备份，并在同一可用区重新连接保留卷；不要并发挂载 SQLite 卷。

目前是单实例、单管理工作区，没有高可用或用户间数据隔离。后续多人试用需要独立工作区授权。新增费用主要是 EC2、公网 IPv4、EBS、快照和少量 Cognito 用量；复用既有 ALB，无新增 ALB 或 NAT 网关费用。

当前最新 CDK 2.271.0 捆绑的开发依赖 `brace-expansion` 5.0.9 有已知 DoS 公告，`npm audit fix` 无法修改厂商捆绑包。它只参与本地受控路径的模板构建，不包含在生产发布包中；已保留此上游限制，后续 CDK 更新需要重新检查。应用依赖安装审计未报告漏洞。
