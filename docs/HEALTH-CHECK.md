# 插件全量体检（2026-11-21）

一次覆盖全部 13 个 Agent 工具的真实执行记录：在本机 Xcode 27.2 上用 `xcodegen` 生成带单元测试与 `#Preview` 的示例应用，跑通「环境 → 工程 → 构建 → 测试 → 模拟器 → 日志/崩溃 → 签名 → MCP → 视觉回归 → 归档/导出」全链路，并记录受签名限制的部分。

## 环境

| 项 | 值 |
| --- | --- |
| Xcode | 27.2（27B52），`/Applications/Xcode-27.2.0.app` |
| Swift | 6.4.2（Xcode 自带） |
| SDK | iOS 27.2 / macOS 27.2 / tvOS 27.2 / watchOS 27.2 / visionOS 27.2 等 10 个 |
| 模拟器 | iPhone 18 Pro（iOS 27.2，UDID `6BF1D140-…`） |
| 真机 | Henry's iPhone（iPhone 16 Pro Max，iOS 27.2.1，UDID `00008140-001E38DA0EF3001C`，已配对） |
| 签名身份 | **0 个** |
| Provisioning Profile | 1 个，已过期（Pengcha，2019-04-24） |
| Xcode MCP | 已连接，`xcode-tools 25464`，54 个工具，审批已通过 |
| fastlane | 2.242.0（homebrew） |
| 插件版本 | 0.6.0（体检时） |

## 结果矩阵

| 工具 | 覆盖动作 | 结果 |
| --- | --- | --- |
| `apple_dev_env` | 工具链 | ✅ Xcode / SDK / Swift / 模拟器 / 0 身份 |
| `apple_dev_project` | `list` / `info` / `build_settings` | ✅ 1 scheme、2 targets（App + Tests）、Debug/Release |
| `apple_dev_build` | 模拟器构建 | ✅ 17.1s，`BUILD SUCCEEDED` |
| `apple_dev_test` | 单元测试 | ✅ 11.4s，1 test / 0 failures，输出 `.xcresult` |
| `apple_dev_simulator` | `list` `boot` `install` `launch` `screenshot` `app_container` `terminate` `shutdown` | ✅ 全部通过；`open` / `erase` 未跑（GUI / 破坏性） |
| `apple_dev_device` | `list` `info` `apps` `processes` `screenshot` | ✅ 真机信息、Safari、PID 78、1320×2868 截图；安装/启动/卸载/终止受签名阻塞 |
| `apple_dev_logs` | `show` `crashes` `symbolicate` | ✅ 2 分钟 516 行日志；真实 `.ips` 符号化出 Swift/XPC 栈；缺 dSYM 的镜像被明确点名 |
| `apple_dev_signing` | `identities` `profiles` `inspect` `entitlements` `verify` | ✅ 0 身份 / 1 过期 profile / adhoc 签名 / `codesign` PASS / `spctl` REJECTED |
| MCP 三件套 | `status` `tools` `call` | ✅ 54 工具，`XcodeListWorkspaces` 实际调用成功（当时无打开的工程） |
| `apple_dev_visual` | `capture` `approve` `compare` | ✅ 模拟器截图基线，**0 / 3,162,132 像素差异**（MATCH）；`source=preview` 本轮未重跑 |
| `apple_dev_release` | `lanes` `lane` `archive` `export` | ✅ lanes 2 个、lane `hello` 成功（ANSI 已剥离）；archive **3.1s 成功**；export ⚠️ 预期失败 `No Team Found in Archive` |

## 发现与处理

### 1. 签名是唯一硬门槛（未解决，需要人工配置）

0 个签名身份导致：真机 `install`/`launch`、`export` 出 IPA、TestFlight/App Store 上传全部不可用；归档可用 `CODE_SIGNING_ALLOWED=NO` 完成，但导出必然失败。

处理：在 Xcode → Settings → Accounts 添加 Apple ID 并生成 Apple Development 证书后，重跑 `apple_dev_signing identities`、`apple_dev_release export`、`apple_dev_device install` 即可。

### 2. `crashes` 输出过大（已修复）

体检中 `apple_dev_logs action=crashes` 会把最新一份 `.ips` 全文（截到 12k 字符）塞进结果，单次响应数万字符。

修复：默认只返回报告列表 + 最新报告的 **parsed summary**（app、版本、异常/信号、终止原因、线程数、崩溃线程）与 `path`；需要全文时显式传 `include_content: true`。

### 3. 真机连接状态表述误导（已修复）

`device list` 曾显示 `disconnected`，但随后 `apps`/`processes`/`screenshot` 全部成功——`connection` 是 CoreDevice 隧道状态，不是命令可用性。

修复：列表行改为分别显示 `paired` 与 `tunnel <state>`（如 `paired · tunnel disconnected`），工具描述也说明二者区别。

## 未覆盖项（及原因）

| 项 | 原因 |
| --- | --- |
| 模拟器 `open` / `erase` | 打开 GUI 窗口 / 抹掉数据，体检不做 |
| 真机 `install` `launch` `uninstall` `terminate` | 需要有效签名 |
| `apple_dev_visual source=preview` | 需要在 Xcode 中打开带 `#Preview` 的工程；该链路已在 MCP 接入阶段用真实 `RenderPreview` 验证 |
| fastlane 上传 lane | 无 App Store Connect 凭据；设计上由项目 Fastfile 负责 |
| MCP 变更类工具 | `mcpAllowMutations: false` 默认关闭（设计如此） |

## 复跑方式

1. 用 xcodegen（或已有工程）准备一个带单元测试与 `#Preview` 的 App；
2. 依次调用：`apple_dev_env` → `apple_dev_project` → `apple_dev_build` → `apple_dev_test`；
3. `apple_dev_simulator` 完成 `boot → install → launch → screenshot/app_container → terminate → shutdown`；
4. `apple_dev_logs show` 过滤 `process`，`crashes` 看摘要，`symbolicate` 传 `.ips` + `.dSYM`；
5. `apple_dev_signing` 五个动作跑一遍（空结果是正常结果）；
6. Xcode 运行时跑 MCP `status` / `tools` / `call`；
7. `apple_dev_visual` 对同一屏 `capture → approve → capture → compare`；
8. `apple_dev_release` 跑 `lanes` / `lane`，`archive`（未签名时加 `extra_args: ["CODE_SIGNING_ALLOWED=NO"]`），有证书后再 `export`。

## 清理

体检使用的临时工程、`/tmp/FastlaneDemo`、`.apple-dev/archives`、`.apple-dev/exports` 已删除；测试 App 已从模拟器卸载、模拟器已关机。构建缓存、截图与视觉基线保留在 `.apple-dev/`（已 gitignore）。
