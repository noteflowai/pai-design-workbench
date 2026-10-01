# 生成代码通道（文本 → CadQuery，沙箱执行）

预设变体不够用时，AI 引擎、外部 Agent（MCP）或维护者可以直接写 CadQuery 代码，生成新的 NEMA 17 支架候选。代码只负责产生一个实体，结论来自与预设变体完全相同的原生 B-Rep 检查（`native/cad_checks.py`）。之后的反馈、复测、发布准入与预设候选走同一条流程。

## 流程

```text
代码（AI 计划 / MCP 提议 / 编辑器）
  → 第 1 层 静态策略（只解析 AST，不执行）       违规：422 CAD_CODE_POLICY，不产生记录
  → 维护者确认
  → 沙箱进程 A：执行代码，只输出精确的 BREP 实体（generated.brep）
  → 沙箱进程 B：读取实体，运行共用检查，导出 STEP/STL/GLB/SVG
  → EvalArc 对照基准零件 → 记录、反馈、复测、发布准入
```

两个进程都在沙箱里运行，因为进程 B 解析的是不可信代码写出的数据。执行代码的进程不做任何测量，所以代码无法篡改检查结果。

## 隔离层

| 层 | 内容 |
|---|---|
| 1 静态策略 `cad_code_policy.py` | 只允许 `import cadquery as cq` 与 `import math`。禁止：下划线名称和属性、给属性赋值、`exec`/`eval`/`open`/`getattr` 等、导出与导入类 API、子模块链（`occ_impl`、`OCP`…）、class、with、try、生成器、global。必须给 `result` 和 `MOTOR_AXIS_Z` 赋值。上限 20 KB、400 行 |
| 2 进程锁定 `cad_lockdown.py` | rlimit：CPU 60 s、地址空间 3 GiB、单文件 64 MiB、256 个文件描述符、不产生 core dump。PEP 578 审计钩子拦截创建进程、socket、ctypes，以及输出目录以外的任何写入。只提供受限的内置函数；`cadquery` 只暴露公开的类和函数，不暴露子模块 |
| 3 OS 沙箱 `src/sandbox.ts` | bubblewrap：`--unshare-all`（无网络，独立的 PID/IPC/UTS/user 命名空间）、`--cap-drop ALL`、`--clearenv`、`--die-with-parent`、`--new-session`。根文件系统只读；主目录、工作台状态、/run、/tmp、/var/lib、/opt/ai、/etc/pai 都替换为空的 tmpfs。只挂回固定版本的 CadQuery venv、native 脚本和本次运行的输入；只有本次输出目录可写。墙钟上限 120 s |

启动时会做一次真实探测：在沙箱中启动解释器，确认无法联网，也看不到主目录。探测不通过时，该通道整体禁用（503 `CAD_SANDBOX_UNAVAILABLE`），不会退回到无隔离执行。AI 引擎和 MCP 也只在探测通过时提供 `cad-code` 工具。

运行结果分四类。只有 `ok` 会进入检查：

- `ok`：产生了实体，进入检查；
- `policy`：违反代码策略；
- `error`：代码出错，或没有恰好一个实体；
- `limit`：超出资源上限。

后三类的记录状态都是 failed，并写明原因，不会产生任何检查证据，也不会自动重试。

## 坐标约定

单位为毫米。电机安装面在 y = 0，电机本体在 y < 0。电机轴平行于 Y，经过 x = 0、z = `MOTOR_AXIS_Z`。底板底面在 z = 0，安装孔竖直。`nema17-interface` 检查会核对止口孔是否与声明的电机轴同轴（偏差 ≤ 0.1 mm），以及安装面是否位于 y = 0；不满足就判失败。可编辑模板见 `native/cad_template.py`：它通过沙箱后的检查结果与预设 reference 逐项相同，这一点由 e2e 测试断言。

## 平台

| 环境 | 状态 |
|---|---|
| 本机 Linux | 可用 |
| pai.oneai.host（Ubuntu 24.04，systemd 加固） | 需要发布脚本安装 bubblewrap 和一个按应用授权的 AppArmor 配置 `infra/apparmor-bwrap`，只给 `/usr/bin/bwrap` 开放 `userns` |
| GitHub CI | 安装 bubblewrap，并放开 AppArmor 对非特权用户命名空间的限制 |
| Docker 镜像 | 默认 seccomp 不允许创建用户命名空间；即使放宽 seccomp、AppArmor 或使用 `--privileged`，bubblewrap 仍无法在新的网络命名空间里配置 loopback。因此镜像中该通道保持禁用并给出原因，其余通道不受影响 |

## 验证

- `npm test`：静态策略对 22 类违规的拒绝、请求契约、沙箱参数的顺序与只读挂载。
- `npm run test:cad-code`：
  - 分别探测 OS 层和进程层；
  - 模板结果与预设 reference 相同；
  - 2.5 mm 板厚判为 min-wall 失败，记录反馈后用修订代码复测通过，反馈关闭；
  - 策略违规不产生记录；
  - 访问子模块、产生两个实体、超出内存、死循环都会失败，且不产生证据。
- 浏览器测试：编辑器中检查策略、在沙箱中运行、得到原生失败、用修订代码复测；AI 生成的代码计划显示代码，越权计划被拒绝，确认后才执行。
