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
  - 工具：Linux x64 可一键安装 Blender 5.2.2 LTS（官方 SHA-256 校验）和 CadQuery 2.8（哈希锁定）；各平台均可手动选择已有的可执行文件，或重启本地服务。
  - 帮助：使用说明、典型用例、关于。
- **首次使用**：Linux x64 没有原生工具时，Blender 和 CAD 页面会提供“安装”按钮。安装复用仓库里的 `tools/setup_native_tools.py` 和 `tools/setup_cadquery.py`，工具装到用户数据目录。Windows 和 macOS 显示选择已有工具的说明；这些平台的自动安装尚未实现，界面和 IPC 均拒绝不支持的安装请求。
- **数据**：工作区数据、工具、设置和服务日志都放在系统的用户数据目录，也可以用 `PAI_DESKTOP_USER_DATA` 指定其他目录。安装包里包含固定版本的 Robot Reel 记录、EvalArc 和 Radar 快照。
- **运行方式**：只允许运行一个实例，窗口大小和位置会被记住；退出应用时，本地服务随之退出。

## 安全

- **页面隔离**：开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`，页面里没有 Node.js。
- **暴露给页面的接口**：只有两个，读取桌面信息和请求安装工具。
- **导航限制**：窗口按完整 origin 校验本机工作台地址，拒绝含凭据或其他端口的地址；其他 HTTP/HTTPS 链接交给系统浏览器打开。IPC 同时验证请求窗口和页面 origin。所有权限请求（摄像头、通知等）默认拒绝。
- **工作台服务**：只监听 `127.0.0.1`，原有的 Host 与 Origin 校验照常生效。
- **平台差异**：生成代码沙箱依赖 bubblewrap，只能在 Linux 上运行（deb 包已声明依赖 `bubblewrap`）。macOS 和 Windows 上，这条通道保持禁用并显示原因，也可以改用 AgentCore 云端沙箱（`PAI_AGENTCORE_SANDBOX_ARN`）。

## 构建

```bash
npm ci && npm run setup:demo
npm run desktop:linux        # 构建 → 生成图标 → 整理应用目录 → electron-builder：AppImage + deb
npm run test:desktop         # 启动打包后的应用，用真实界面和原生 CadQuery 跑典型用例 C2，再检查首次安装路径
```

Windows（nsis）和 macOS（dmg，arm64）安装包由 GitHub Actions 的 `Desktop packages` 工作流构建，打 tag 或手动触发即可。这些包都没有签名，正式分发前需要配置代码签名和 macOS 公证。

`tools/runtime-pins.json` 是三项公开依赖提交的共同登记点。准备和启动均选择登记的提交，不从缓存中猜测版本。打包前检查提交和工作区状态，只复制 Git 跟踪的文件；忽略的密钥、缓存和 `.git` 不进入安装包。临时目录准备成功后才替换应用和依赖，准备失败保留旧输入；既有 `dist` 安装包始终保留。文件 URL 使用 `fileURLToPath` 转换，支持 Windows 盘符、空格、非 ASCII 字符和 `%`。

## 验证

普通 PR 和 main 桌面改动会在 Linux、Windows、macOS 上运行路径/提交/失败保留测试并整理真实应用目录。手动触发或版本 tag 还会生成安装包，并在三平台上启动打包后的应用。失败时也上传已经生成的 JSON 证据；启动、交互和清理均设置超时，清理只处理测试自己启动的进程。外链测试替换系统浏览器调用，避免 CI 启动外部浏览器后挂起。

`npm run test:desktop`（`scripts/desktop-e2e.ts`）用 Playwright 驱动打包后的应用。默认按 electron-builder 的 `executableName` 定位各平台 unpacked 程序（包括 macOS 的 bundle 名称），也可通过 `PAI_DESKTOP_EXE` 指定其他产物。定位失败也写入 JSON 证据：
- 版本与安全：Electron 44.5.1、Node 24.21.0；安全设置（contextIsolation、sandbox、无 nodeIntegration、页面内无 Node、外部导航被拦截）全部生效；5 个菜单齐全。
- 典型用例 C2：通过界面完成，原生 CadQuery 判定轻量化方案为最小壁厚不合格。
- 退出：关闭应用后，本地服务端口不再响应。
- 首次安装：Linux x64 提供安装按钮；Windows/macOS 显示手动配置说明并拒绝不支持的安装请求。

工作流使用 `--smoke` 检查启动、隔离、菜单、平台能力和退出；本地完整测试还需要设置 `PAI_CADQUERY_PYTHON`，执行真实 C2 案例。证据包含测试模式和结果，不把 smoke 记作已验证原生 C2。

结果见 [desktop-e2e.json](evidence/desktop-e2e.json)。
