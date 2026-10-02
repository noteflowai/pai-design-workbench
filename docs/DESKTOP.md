# 桌面端

PAI Design Workbench 桌面版基于 Electron 44.5.1，内置 Node 24.21.0 和 Chromium 152。启动时，它在 Electron 的 utility process 里运行**未经修改的**工作台服务（只监听本机回环端口），再在加固过的窗口中打开这个页面。服务端代码没有分叉，界面就是网页版，原生工具仍是外部程序。

## 为什么选 Electron 而不是 Tauri

| 维度 | Electron 44 | Tauri 2.12 |
|---|---|---|
| 后端复用 | 内置的 Node 24.21.0 与项目固定的版本完全一致，服务端直接运行 | 需要把 Node 作为外挂程序（sidecar）打包，并额外写 Rust 胶水代码 |
| 渲染 | 各平台统一使用 Chromium，与网页版和 Playwright 测试的引擎相同 | 使用系统 WebView：Windows 为 WebView2，macOS 为 WKWebView，Linux 为 WebKitGTK；three.js 视口需在三个平台分别验证 |
| 体积 | 约 0.2 GB（AppImage） | 外壳很小，但加上 Node 后也接近 0.1 GB |
| 同类产品 | VS Code、Figma 桌面版、Claude 桌面版 | 多用于轻量工具 |

如果只需要一个连接托管站点的瘦客户端，Tauri 更合适；本项目的桌面版要在本机运行原生工具，所以选 Electron。

## 功能

- **原生菜单**
  - 文件：新建评审任务（Ctrl+N）、打开数据目录、打开服务日志。
  - 视图：命令面板（Ctrl+K）、AI 助手（Ctrl+J）、外观（跟随系统 / 浅色 / 深色）、缩放、全屏。
  - 工具：一键安装 Blender 5.2.2 LTS（官方 SHA-256 校验）和 CadQuery 2.8（哈希锁定），也可以手动选择已有的可执行文件；重启本地服务。
  - 帮助：使用说明、典型用例、关于。
- **首次使用**：没有原生工具时，Blender 和 CAD 页面会直接提供“安装”按钮，不会停在“未配置”。安装复用仓库里的 `tools/setup_native_tools.py` 和 `tools/setup_cadquery.py`，工具装到用户数据目录。
- **数据**：工作区数据、工具、设置和服务日志都放在系统的用户数据目录，也可以用 `PAI_DESKTOP_USER_DATA` 指定其他目录。安装包里包含固定版本的 Robot Reel 记录、EvalArc 和 Radar 快照。
- **运行方式**：只允许运行一个实例，窗口大小和位置会被记住；退出应用时，本地服务随之退出。

## 安全

- **页面隔离**：开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，页面里没有 Node.js。
- **暴露给页面的接口**：只有两个，读取桌面信息和请求安装工具。
- **导航限制**：窗口只能加载本机工作台，其他链接一律交给系统浏览器打开。所有权限请求（摄像头、通知等）默认拒绝。
- **工作台服务**：只监听 `127.0.0.1`，原有的 Host 与 Origin 校验照常生效。
- **平台差异**：生成代码沙箱依赖 bubblewrap，只能在 Linux 上运行（deb 包已声明依赖 `bubblewrap`）。macOS 和 Windows 上，这条通道保持禁用并显示原因，也可以改用 AgentCore 云端沙箱（`PAI_AGENTCORE_SANDBOX_ARN`）。

## 构建

```bash
npm ci && npm run setup:demo
npm run desktop:linux        # 构建 → 生成图标 → 整理应用目录 → electron-builder：AppImage + deb
npm run test:desktop         # 启动打包后的应用，用真实界面和原生 CadQuery 跑典型用例 C2，再检查首次安装路径
```

Windows（nsis）和 macOS（dmg，arm64）安装包由 GitHub Actions 的 `Desktop packages` 工作流构建，打 tag 或手动触发即可。这些包都没有签名，正式分发前需要配置代码签名和 macOS 公证。

## 验证

`npm run test:desktop`（`scripts/desktop-e2e.ts`）用 Playwright 驱动打包后的应用，分别测试 linux-unpacked 目录和 AppImage 本身：
- 版本与安全：Electron 44.5.1、Node 24.21.0；安全设置（contextIsolation、sandbox、无 nodeIntegration、页面内无 Node、外部导航被拦截）全部生效；5 个菜单齐全。
- 典型用例 C2：通过界面完成，原生 CadQuery 判定轻量化方案为最小壁厚不合格。
- 退出：关闭应用后，本地服务端口不再响应。
- 首次安装：没有原生工具时，CAD 和 Blender 页面都提供安装按钮。

结果见 [desktop-e2e.json](evidence/desktop-e2e.json)。
