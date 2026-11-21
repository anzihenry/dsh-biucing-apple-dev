# dsh-biucing-apple-dev

一个 [DeepSeek Harness](https://github.com/deepseek-harness) 持久化插件，为 Apple 平台（iOS / iPadOS、macOS、tvOS、watchOS、visionOS）应用的**开发、调试、测试**提供一整套 Agent 工具与一个设置页。

插件把 Xcode 与 CoreSimulator 的能力交给 Agent：发现工具链、检查工程、构建、跑测试、管理模拟器与真机、抓日志与崩溃报告（含 dSYM 符号化）、检查代码签名，并通过 Xcode 内置 MCP 调用构建、Preview、设备交互、控制台与调试器。所有命令都通过 Host 的 `subprocess` 服务执行，插件本身零依赖、无需构建步骤。

## 能力

| 工具 | 作用 |
| --- | --- |
| `apple_dev_env` | Xcode 版本与活动 Developer 目录、已安装 Xcode、SDK、Swift 版本、模拟器运行时/设备、签名身份。Apple 项目第一步先调它。 |
| `apple_dev_project` | 发现 `.xcodeproj` / `.xcworkspace` / `Package.swift`；`xcodebuild -list -json` 的 schemes/targets/configurations；`swift package describe`；关键 build settings。 |
| `apple_dev_build` | `xcodebuild build`（或 `swift build`）：scheme、configuration、destination、DerivedData、额外参数；解析 `BUILD SUCCEEDED/FAILED`、错误行与警告数，完整日志落盘。 |
| `apple_dev_test` | `xcodebuild test`（或 `swift test`）：`only_testing`、result bundle；解析执行数/失败数与失败用例。 |
| `apple_dev_simulator` | 模拟器生命周期：list / boot / shutdown / erase / open，安装 `.app`、按 bundle id 启动/终止、截图、打印 app 容器路径。`boot` 不传 `device` 时自动选最新的可用 iPhone。 |
| `apple_dev_device` | 真机（`devicectl`）：列出已配对设备、详情/已装应用/运行进程、安装/卸载、启动/终止、截屏。 |
| `apple_dev_logs` | 模拟器日志（`simctl spawn … log show`，按 process/subsystem/category/消息过滤）、最近的 `.ips` 崩溃报告，以及用 dSYM + `atos` 的崩溃符号化（`symbolicate`）。 |
| `apple_dev_signing` | 签名身份、Provisioning Profile（解码后的元数据）、`codesign -dv`、entitlements、`codesign --verify` / `spctl` 评估。 |
| `apple_dev_release` | 发布链路：`archive`（`xcodebuild archive`，输出 `.xcarchive` 与 dSYMs）、`export`（`-exportArchive` + 生成/自带 ExportOptions.plist，输出 IPA）、`lanes`（查找 Fastfile 并列出 lane）、`lane`（运行 fastlane lane，上传交给项目自己的 `beta`/`deliver` lane）。 |
| `apple_dev_visual` | 截图基线与像素回归：`capture`（模拟器截图 / 现有 PNG / Xcode MCP Preview）、`approve`、`compare`（带容差的像素 diff + 红色标注 diff 图）、`list`。 |
| `apple_dev_xcode_status` | Xcode 内置 MCP server 的连接状态：bridge、server 版本、工具数、打开的 workspace、是否待审批。 |
| `apple_dev_xcode_tools` | Xcode MCP 工具的紧凑目录（名称、必填参数、是否改工程文件、一句话说明），支持 `query` 过滤。 |
| `apple_dev_xcode_call` | 按名称调用任意 Xcode MCP 工具：构建、测试、Preview、模拟器点击/输入、控制台日志、LLDB、String Catalog 等。 |

外加一个 **Apple Dev** 设置页（`设置 → Apple Dev`）：显示工具链状态、**Xcode MCP 连接状态与工具数**、按平台分组的模拟器列表，可直接 Boot / Shutdown / Open / Erase；MCP 卡片还能**重新连接**，或输入 `.xcodeproj`/`.xcworkspace` 路径**打开工程**（触发 Xcode 的一次性审批）。设置页和 `apple_dev_simulator` 调用同一套 `lib/simulator.js` 实现，没有第二套逻辑。

## Xcode MCP（Xcode 26+）

Xcode 26 起自带 MCP server，Xcode 27 的工具面已经很完整：workspace/构建/测试/Preview、模拟器交互（点击、输入、截图、UI 层级）、控制台日志、LLDB、崩溃与性能问题、工程与 String Catalog 编辑、文档检索。插件通过 `xcrun mcpbridge` 的 stdio JSON-RPC 接入这些能力，但**不把 54 个工具原样注册**——实测原始 schema 约 151 KB（≈3.8 万 token），每个请求都要付。插件改为三个小工具做网关：

- `apple_dev_xcode_status`：连接状态与审批状态；
- `apple_dev_xcode_tools`：按需列出、过滤工具目录（约 9 KB，只在调用时进入上下文）；
- `apple_dev_xcode_call`：按名称透传参数调用任意 MCP 工具。

首次调用需要审批：Xcode 只对"被 agent 打开过 workspace"的客户端放行。所以第一次应调用：

```text
apple_dev_xcode_call { "tool": "XcodeOpenWorkspace", "arguments": { "path": "/abs/path/App.xcodeproj" } }
```

Xcode 会弹出审批（agent + 该目录访问权限），批准一次后其余工具复用。`apple_dev_xcode_status` 会把这条路径直接写在提示里。**改工程文件/构建设置的工具默认禁止**（`XcodeWrite`、`XcodeUpdate`、`XcodeRM`、`XcodeNewProject`、`AddInfoPlist`、`StringCatalogEdit` 等 13 个），需要显式打开 `mcpAllowMutations: true`。

MCP 返回的图片（Preview 截图、设备截图）落到 `.apple-dev/logs/mcp/`，工具只回路径与大小；超长文本落到 `.apple-dev/logs/mcp-*.log`。设置页的「Xcode MCP」卡片会显示连接状态、server 版本、工具数与审批状态，首次探测在后台完成，不会拖慢页面。

## 环境要求

- macOS，已安装 Xcode（含 Command Line Tools 与至少一个模拟器运行时）；Xcode MCP 需要 Xcode 26+ 且 Xcode 正在运行
- DeepSeek Harness 桌面版或 Web 版（Host 侧需要 `tools`、`subprocess`、`webServer` 服务）
- 模拟器 GUI：Xcode 26+ 使用 `DeviceHub.app`，旧版使用 `Simulator.app`；`apple_dev_simulator` 的 `open` 动作会按顺序尝试两者及其在 Xcode 内的路径

## 安装

插件是标准 DSH bundle，在插件工作区用 `plugin_manager` 安装：

```text
plugin_manager(action: "install_bundle", target: "/Users/xiejinheng/Coding/dsh-biucing-apple-dev")
```

安装会在当前 profile 的 `cordis.patch.yml` 中插入一行（id `biucing-apple-dev`），并链接本地目录；重启 Harness 或等待 HMR 后生效。卸载用 `remove_bundle`，临时禁用用 `set_plugin`。

## 配置

安装后可在 profile 的 `cordis.patch.yml` 覆盖插件配置（默认值见 `cordis.patch.yml`）：

```yaml
- id: biucing-apple-dev
  name: 'dsh-biucing-apple-dev'
  config:
    xcodebuild: /Applications/Xcode-27.2.0.app/Contents/Developer/usr/bin/xcodebuild
    developerDir: /Applications/Xcode-27.2.0.app/Contents/Developer
    derivedDataPath: .apple-dev/DerivedData
    logDirectory: .apple-dev/logs
    timeoutMs: 1200000
    maxOutputBytes: 8000000
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `xcodebuild` | `xcodebuild` | 可执行名或绝对路径。 |
| `developerDir` | 空 | 设置后作为 `DEVELOPER_DIR`，用于固定某个 Xcode。 |
| `derivedDataPath` | `.apple-dev/DerivedData` | 相对会话工作目录；留空用 Xcode 默认。 |
| `logDirectory` | `.apple-dev/logs` | 构建/测试完整日志与截图目录。 |
| `timeoutMs` | `900000` | 单条命令墙钟上限。 |
| `maxOutputBytes` | `4000000` | 每个输出流保留字节；完整流另存 spill 文件。 |
| `mcpEnabled` | `true` | 是否注册三个 Xcode MCP 网关工具。 |
| `mcpCommand` / `mcpArgs` | `xcrun` / `[mcpbridge]` | MCP stdio bridge 的启动命令。 |
| `mcpStartupTimeoutMs` | `30000` | initialize + tools/list 的握手预算。 |
| `mcpToolCallTimeoutMs` | `600000` | 单次 MCP 调用预算（构建、测试、Preview 渲染可能很久）。 |
| `mcpAllowMutations` | `false` | 允许 MCP 修改工程文件与构建设置；默认只读。 |
| `visualDirectory` | `.apple-dev/visual` | 截图基线目录（每个 name 一个子目录）。 |
| `visualTolerance` | `12` | 像素比较的每通道容差（0-255）。 |
| `visualMaxDiffRatio` | `0.002` | 仍判定为一致的差异像素占比上限（0.2%）。 |
| `archiveDirectory` | `.apple-dev/archives` | `archive` 的输出目录（`.xcarchive`）。 |
| `exportDirectory` | `.apple-dev/exports` | `export` 的输出目录（IPA 与生成的 plist）。 |

工作区已把 `.apple-dev/` 加入 `.gitignore`。

## 使用示例

- “看下这台机器能构建哪些目标” → `apple_dev_env`
- “检查 Runner.xcworkspace 有哪些 scheme，然后构建 Debug 到 iPhone 17 模拟器” → `apple_dev_project` → `apple_dev_build`
- “在 iPhone 17 上跑单元测试，只跑 LoginTests” → `apple_dev_test`（`only_testing`）
- “把构建出来的 App 装到模拟器并启动，给我最近 5 分钟 App 的日志” → `apple_dev_simulator`（install/launch）→ `apple_dev_logs`
- “这个 App 为什么装不上？看下签名与 entitlements” → `apple_dev_signing`

日志、构建日志等大输出只把摘要返回给模型，完整内容落在 `.apple-dev/logs/`，路径随结果返回，可用 `read` / `read_image`（截图）继续查看。

## 设计约束

- **命令出口唯一**：所有子进程经 `lib/runner.js` → Host `subprocess`，统一超时、取消、输出上限与 spill；插件代码不使用 `node:child_process`。
- **零依赖**：只 import Node 内置模块与同目录文件；无构建步骤，`client.js` 是手写的单文件浏览器模块。
- **只读优先**：签名相关工具只读；设置页 action 路由只允许 `boot | shutdown | open | erase` 四个动作，且仅接受同源请求，没有通用命令通道。
- **macOS 守卫**：非 macOS Host 上工具返回可读错误而不是崩溃。
- **模型上下文有界**：每个工具渲染文本都会裁剪，完整日志落盘。

## 开发与测试

一次覆盖全部工具的真实执行记录（含受签名限制的项）见 [`docs/HEALTH-CHECK.md`](docs/HEALTH-CHECK.md)。

```bash
cd dsh-biucing-apple-dev
node --check index.js && node --check lib/*.js && node --check client.js
node --test
```

修改已安装插件的文件后，不必重启 Harness：在 Plugin Manager 里把 `biucing-apple-dev` 这一行禁用再启用，会触发一次 profile 重组，HMR 会替换磁盘上已变化的模块（这正是本次交付自检时使用的热更新方式）。

结果边界：Harness 要求工具结果是「无损 JSON」，插件在 `index.js` 的注册边界统一调用 `toLosslessJson()` 清洗（去掉 `undefined`、把 `NaN/Infinity` 与 `-0` 归一、处理 `Date`/循环引用），工具实现本身不必逐处记得。

| 目录 | 内容 |
| --- | --- |
| `index.js` | Host 入口：注册工具与设置页路由 |
| `lib/runner.js` | 子进程、配置、路径、会话目录 |
| `lib/env.js` | 工具链发现与解析器 |
| `lib/simulator.js` | `simctl` 生命周期操作 |
| `lib/device.js` | `devicectl` 真机命令与 JSON 解析 |
| `lib/crash.js` | `.ips` 解析、dSYM 查找与 `atos` 符号化 |
| `lib/tools-device.js` | `apple_dev_device` 工具 |
| `lib/visual.js` | 截图基线存储、BMP 解析/编码与像素 diff |
| `lib/tools-visual.js` | `apple_dev_visual` 工具 |
| `lib/release.js` | 归档/导出 argv、ExportOptions.plist、fastlane lane 解析 |
| `lib/tools-release.js` | `apple_dev_release` 工具 |
| `lib/tools-*.js` | 各工具的 schema / execute / render |
| `lib/mcp.js` | Xcode MCP stdio 客户端（JSON-RPC、懒连接、超时与重连） |
| `lib/tools-mcp.js` | 三个 MCP 网关工具与产物落盘 |
| `lib/ui.js` | `/dsh-biucing-apple-dev/status` 与 `/action` 路由 |
| `client.js` | Apple Dev 设置页（Client 模块） |
| `test/` | 解析器、工具、路由、MCP 协议与客户端字典测试 |

内部契约见 [`docs/CONTRACTS.md`](docs/CONTRACTS.md)。

## 已知限制

- 真机通过 `apple_dev_device`（`devicectl`）支持列表、详情、应用、进程、安装/卸载、启动/终止与截屏；安装/启动仍需要可用签名，插件不代签名，`apple_dev_signing` 只做只读诊断。
- 真机 `terminate` 需要 PID（先用 action=processes 或 launch 返回的 pid 获取）。
- 崩溃符号化只处理 `.ips`（JSON）；旧式 `.crash` 文本报告只做内容读取，不走 `atos`。
- Xcode MCP 的首次审批必须在 Xcode 界面点一次；无头模式需要 `sudo xcrun mcp-server enable`（插件不做提权）。
- MCP 工具依赖 Xcode 当前打开的 workspace/scheme/run destination，多工程并行时以 Xcode 的当前状态为准。
- `apple_dev_logs` 的崩溃报告按“最新一份 + 路径”返回，符号化需配合 `atos` 与 dSYM 手动完成。
- 构建/测试日志解析覆盖常见 `xcodebuild` 与 `swift test` 输出（XCTest 与 Swift Testing 两种计数）；极端自定义 formatter 可能让部分错误行只出现在 `logPath` 中。
- 设置页的视觉呈现（明暗主题、导航项排布）需在运行中的 GUI 里人工确认；本仓库的自动验证覆盖注册、路由契约与页面状态机。
- Xcode 工程路径经过真实 `xcodebuild` 构建验证；具体工程的签名/部署目标问题由工具如实报告，不做自动修复。

## License

未声明许可证前，保留所有权利。
