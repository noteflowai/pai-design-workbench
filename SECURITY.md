# 安全说明

## 报告漏洞

请在仓库的 **Security → Report a vulnerability** 私下提交，不要开公开 issue。请附上复现步骤和受影响的版本或提交。

## 范围

- 本仓库的代码：工作台服务、原生通道、生成代码沙箱、桌面端和部署模板（`infra/`）。
- 托管站点 pai.oneai.host 只给单个管理员使用。所有路由都要经过 ALB + Cognito 登录，实例只接受来自 ALB 的流量。请不要对它做压力测试或扫描。

## 仓库里没有的东西

仓库不含任何凭据。Kiro API 密钥放在 AWS Secrets Manager；管理员口令、登录状态、提示词和回答、SQLite 账本都只保存在被 Git 忽略的 `.state/`。CI 不使用仓库 secrets，也不获取云端凭据。

仓库里出现的 AWS 账号 ID、VPC/安全组 ID 和 ARN 只是资源标识，不能用来访问资源。访问需要账号内的 IAM 权限。
