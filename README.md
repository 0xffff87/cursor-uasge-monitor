# Cursor Usage Monitor

[English](#english) | [中文](#中文)

---

## English

A VS Code / Cursor IDE extension that displays your Cursor AI usage directly in the sidebar. Monitor your token consumption, request counts, costs, and usage limits at a glance.

### Features

- **Monthly Summary** — View Included Requests and On-Demand Usage with reset countdown
- **Recent Usage** — Detailed per-conversation breakdown: model, tokens, requests, and cost
- **Auto Refresh** — Configurable polling interval (default: 30 seconds) with exponential backoff on failures
- **Expandable Details** — Click any usage entry to see tokens, requests, and cost breakdown
- **Token I/O Toggle** — Optionally show input/output token breakdown (right-click Tokens row)
- **Context Menus** — Right-click to configure display count, polling interval, and session token
- **Hide Items** — Right-click to hide individual items (e.g., Included Requests)
- **Status Bar** — Pin items to the bottom status bar for always-visible monitoring
- **Usage Alerts** — Configurable notifications when usage changes exceed thresholds
- **i18n** — Full English and Chinese (Simplified) localization
- **Remote development** — Declared as a UI extension (`extensionKind: ui`) so it runs on your **local** machine and can still read your Cursor session when the workspace is on **SSH Remote**, WSL, or Dev Containers

### Installation

1. Download or build the `.vsix` package
2. In Cursor/VS Code: `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. Select the `.vsix` file
4. Reload the window

### Authentication

The extension attempts to automatically detect your Cursor session from local config files. If automatic detection fails:

1. Click the **key icon** (🔑) in the "Cursor Usage" view title bar
2. Enter your `WorkosCursorSessionToken` cookie value (format: `userId%3A%3AaccessToken`)
3. The token is securely stored using VS Code's SecretStorage (encrypted, never in plain text)

To find your token: Open browser DevTools on [cursor.com](https://cursor.com), go to Application → Cookies, and copy the `WorkosCursorSessionToken` value.

> **Upgrade note**: If you previously stored your token in `settings.json`, it will be automatically migrated to SecretStorage and removed from `settings.json` on first launch.

**Remote SSH, WSL, and Dev Containers:** From v1.1.8, this extension is a **UI extension**. It runs in the **local** Cursor/VS Code process (where your Cursor login and `state.vscdb` live), not on the remote host. Install the extension in your **local** Cursor/VS Code; you do not need to install it on the remote server for auto session detection to work. If automatic detection still fails, use the **key icon** to paste `WorkosCursorSessionToken` as usual.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `displayCount` | 5 | Number of recent usage entries to display |
| `pollingInterval` | 30 | Polling interval in seconds |
| `idleInterval` | 60 | Idle polling interval in seconds |
| `showTokenDetail` | false | Show input/output token breakdown |
| `hiddenItems` | [] | Items hidden from sidebar (includedRequests, onDemandUsage) |
| `statusBarItems` | [] | Items pinned to status bar |
| `alertEnabled` | true | Enable usage change alerts |
| `alertItems` | ["newSession", "includedRequests", "onDemandSpending"] | Items to monitor for alerts |
| `alertThreshold.newSession` | 2 | New usage requests threshold |
| `alertThreshold.includedRequests` | 10 | Included requests change threshold |
| `alertThreshold.onDemandSpending` | 1 | On-demand spending change threshold ($) |
| `alertThreshold.totalTokens` | 100000 | Total tokens change threshold |
| `blockMaxModeChat` | false | Block sending messages to AI when MAX Mode is enabled |

### Sidebar Display

```
📊 Monthly Summary (Reset in: 8d 12h)
  ├── Included Requests    500/500
  └── On-Demand Usage      $37.20/$200

📋 Recent Usage (5 entries)
  ├── 03-17 14:54  Claude 4.6 Opus    On-Demand
  │   ├── Tokens: 109.5万
  │   ├── Requests: 2
  │   └── Cost: $1.23
  └── ...
```

### Right-Click Menus

| Location | Menu Items |
|----------|-----------|
| View title bar | Refresh, Set Token, Configure Alerts |
| "Monthly Summary" | Set Polling Interval, Show All Items |
| "Recent Usage" | Set Display Count, Set Polling Interval |
| Included/On-Demand items | Hide Item, Pin to Status Bar, Unpin |
| Tokens row | Toggle Token Details |

### Usage Alerts

Configure alerts to get notified when usage changes exceed thresholds:

1. Click the 🔔 icon in the view title bar
2. Enable alerts → Select monitoring items → Set thresholds
3. Available monitors: New usage requests, Included Requests, On-Demand spending, Token consumption
4. All thresholds can be set to 0 (any change triggers alert)

> Thresholds are checked on each poll cycle (every `pollingInterval` seconds). The threshold value represents the **change delta** between two consecutive polls, not a cumulative or absolute value. For example, `onDemandSpending` threshold of `1.0` means an alert triggers when spending increases by $1.00 or more between two consecutive checks.

### Logs

| Log Channel | Location | Content |
|-------------|----------|---------|
| `Cursor Usage Monitor - Extension` | Output Panel (`Ctrl+Shift+U`) | Plugin lifecycle, config, MAX Mode events |
| `Cursor Usage Monitor` | Output Panel | HTTP API requests and responses |
| `Cursor Usage Monitor - Tracker` | Output Panel | Polling state, snapshots, alerts |
| `Cursor Usage Monitor - Credentials` | Output Panel | Token detection, database queries |
| Hook script | `globalStorage/kso.cursor-usage-monitor/hook.log` | MAX Mode block hook invocations |

### Build from Source

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

---

## 中文

一款 VS Code / Cursor IDE 扩展，在侧边栏直接显示 Cursor AI 的用量信息。一目了然地监控 Token 消耗、请求数、费用和用量限额。

### 功能特性

- **本月汇总** — 查看 Included Requests 和 On-Demand Usage，含重置倒计时
- **最近消耗** — 每次对话的详细信息：模型、Tokens、请求数、费用
- **自动刷新** — 可配置的轮询间隔（默认 30 秒），失败时自动指数退避
- **可展开详情** — 点击任意用量记录查看 Tokens、请求数和费用明细
- **输入/输出切换** — 右键 Tokens 行可切换显示输入/输出 Token 明细
- **右键菜单** — 右键可配置显示条数、刷新间隔和 Session Token
- **隐藏项目** — 右键可隐藏单个项目（如 Included Requests 用完后隐藏）
- **状态栏固定** — 将项目固定到底部状态栏，不占用项目树空间
- **用量提醒** — 可配置的通知，当用量变化超过阈值时弹窗提醒
- **国际化** — 完整的中英文本地化支持
- **远程开发** — 声明为 UI 类扩展（`extensionKind: ui`），在**本机**运行，工作区在 **SSH Remote**、WSL 或 Dev Containers 时仍能读取本机 Cursor 登录状态

### 安装方法

1. 下载或构建 `.vsix` 安装包
2. 在 Cursor/VS Code 中：`Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. 选择 `.vsix` 文件
4. 重新加载窗口

### 认证方式

扩展会尝试自动从本地配置文件检测 Cursor 会话。如果自动检测失败：

1. 点击 "Cursor 用量" 视图标题栏中的 🔑 图标
2. 输入 `WorkosCursorSessionToken` Cookie 值（格式：`userId%3A%3AaccessToken`）
3. Token 使用 VS Code SecretStorage 加密存储，不会以明文形式出现在配置文件中

获取方法：浏览器打开 [cursor.com](https://cursor.com) → F12 → Application → Cookies → 复制 `WorkosCursorSessionToken`。

> **升级说明**：如果你之前在 `settings.json` 中存储了 Token，插件首次启动时会自动将其迁移到 SecretStorage 并从 `settings.json` 中删除明文记录。

**SSH Remote、WSL、Dev Containers：**从 **v1.1.8** 起，本扩展为 **UI 扩展**，在**本机** Cursor/VS Code 进程中运行（与 Cursor 登录与 `state.vscdb` 所在环境一致），而不是在远程 Extension Host 中。请在**本机**安装扩展；自动读取会话**无需**在远程服务器再装一份。若仍无法自动检测，请照常使用标题栏 **钥匙** 手动粘贴 `WorkosCursorSessionToken`。

### 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `displayCount` | 5 | 显示最近用量记录条数 |
| `pollingInterval` | 30 | 轮询间隔（秒） |
| `idleInterval` | 60 | 空闲时的轮询间隔（秒） |
| `showTokenDetail` | false | 是否显示 Token 输入/输出明细 |
| `hiddenItems` | [] | 侧边栏隐藏的项目 |
| `statusBarItems` | [] | 固定到状态栏的项目 |
| `alertEnabled` | true | 启用用量变化提醒 |
| `alertItems` | ["newSession", "includedRequests", "onDemandSpending"] | 提醒监控项 |
| `alertThreshold.newSession` | 2 | 新增调用请求阈值 |
| `alertThreshold.includedRequests` | 10 | Included Requests 变化阈值 |
| `alertThreshold.onDemandSpending` | 1 | On-Demand 花费变化阈值（$） |
| `alertThreshold.totalTokens` | 100000 | Token 总量变化阈值 |
| `blockMaxModeChat` | false | 开启后在 MAX Mode 激活时阻止向 AI 发送消息 |

### 侧边栏显示效果

```
📊 本月汇总（重置倒计时：8天12小时）
  ├── Included Requests    500/500
  └── On-Demand Usage      $37.20/$200

📋 最近消耗 (5 条)
  ├── 03-17 14:54  Claude 4.6 Opus    On-Demand
  │   ├── Tokens: 109.5万
  │   ├── Requests: 2
  │   └── 费用: $1.23
  └── ...
```

### 右键菜单

| 位置 | 菜单项 |
|------|--------|
| 视图标题栏 | 刷新、设置 Token、配置提醒 |
| "本月汇总" 行 | 设置刷新间隔、显示全部项 |
| "最近消耗" 行 | 设置显示条数、设置刷新间隔 |
| Included/On-Demand 项 | 隐藏此项、固定到状态栏、从状态栏移除 |
| Tokens 行 | 切换 Token 详情 |

### 用量提醒

配置提醒，当用量变化超过阈值时收到通知：

1. 点击标题栏 🔔 图标
2. 开启提醒 → 选择监控项 → 设置阈值
3. 可监控项：新增调用请求、Included Requests、On-Demand 花费、Token 消耗
4. 阈值可设为 0（任何变化都会触发提醒）

> 阈值在每次轮询时检查（间隔为 `pollingInterval` 秒）。阈值表示的是**两次轮询之间的变化量**，而非累计值或绝对值。例如 `onDemandSpending` 阈值设为 `1.0`，表示当两次检查之间花费增加了 $1.00 或以上时触发提醒。

### 日志位置

| 日志通道 | 位置 | 内容 |
|----------|------|------|
| `Cursor Usage Monitor - Extension` | 输出面板（`Ctrl+Shift+U`） | 插件生命周期、配置、MAX Mode 事件 |
| `Cursor Usage Monitor` | 输出面板 | HTTP API 请求和响应 |
| `Cursor Usage Monitor - Tracker` | 输出面板 | 轮询状态、快照、提醒 |
| `Cursor Usage Monitor - Credentials` | 输出面板 | Token 检测、数据库查询 |
| Hook 脚本 | `globalStorage/kso.cursor-usage-monitor/hook.log` | MAX Mode 拦截 Hook 调用记录 |

### 从源码构建

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

---

## Changelog / 更新日志

### v1.2.7

**New Features**

- **Block MAX Mode Chat**: New option `blockMaxModeChat` to prevent sending messages to AI when MAX Mode is enabled. Uses Cursor Hooks (`beforeSubmitPrompt`) to intercept and block message submission, with a notification indicating the plugin blocked the action
- New command "Install/Remove MAX Mode Block Hook" to manage the hook lifecycle from the Command Palette

**Bug Fixes**

- Fixed Vercel Security Checkpoint (HTTP 403) blocking all API requests when polling too frequently
- Added exponential backoff: on consecutive failures, the polling interval doubles each time (up to 5 minutes), then recovers to the base interval on success
- Raised the minimum `pollingInterval` from 1 second to 10 seconds to prevent triggering Vercel's rate limiting
- Old user configs with `pollingInterval` below 10 are automatically migrated to 10 on plugin startup

**新功能**

- **禁止 MAX Mode 对话**：新增 `blockMaxModeChat` 选项，开启后在 MAX Mode 激活时阻止向 AI 发送消息。通过 Cursor Hooks（`beforeSubmitPrompt`）拦截消息发送，并弹窗提示是本插件阻止的
- 新增命令"安装/卸载 MAX Mode 拦截 Hook"，可在命令面板中管理 Hook 的安装和移除

**修复**

- 修复轮询频率过高时触发 Vercel 安全检查 (HTTP 403) 导致所有 API 请求被拦截的问题
- 新增指数退避机制：连续失败时轮询间隔按 2^n 倍递增（最大 5 分钟），成功后自动恢复到基础间隔
- `pollingInterval` 最小值从 1 秒提高到 10 秒，避免触发 Vercel 频率限制
- 旧版本中设置的低于 10 秒的轮询间隔会在插件启动时自动迁移为 10 秒

### v1.2.6

**Changes**

- Changed default polling interval from 3 seconds to 30 seconds. On slower networks, a 3-second interval could cause the plugin to stay in a perpetual loading state since the previous request hadn't completed before the next one started.
- Adjusted default alert thresholds to reduce noise:
  - `newSession`: 0 → 2 (triggers when 2+ new requests appear in a single poll)
  - `includedRequests`: 0 → 10 (triggers when included requests change by 10+)
  - `onDemandSpending`: 0 → 1 (triggers when spending increases by $1+)

**变更**

- 默认轮询间隔从 3 秒改为 30 秒。部分用户网络较慢时，3 秒的刷新间隔会导致上一次请求尚未完成就发起下一次，使插件一直处于 loading 状态。
- 调整提醒阈值默认值，减少频繁弹窗干扰：
  - `newSession`：0 → 2（单次轮询新增 2 个以上请求时才提醒）
  - `includedRequests`：0 → 10（Included Requests 变化 10 以上时才提醒）
  - `onDemandSpending`：0 → 1（On-Demand 花费增加 $1 以上时才提醒）

### v1.2.5

**Bug Fixes**

- Fixed critical poll race condition: SKIPPED polls no longer overwrite `_activePollId`, preventing all successful poll results from being discarded as "expired". This was the root cause of the UI never updating.
- Fixed manual token fallback: when the auto-retrieved token from the Cursor database is expired (401), the plugin now correctly falls back to the user's manually set token instead of retrying with the same expired token.

**Enhancements**

- Enhanced diagnostic logging across all log channels:
  - Extension.log: plugin version, platform, and key config on startup
  - Monitor.log: token source (auto/manual), `_autoTokenFailed` state, sub-API failure details, 401 retry details
  - Credentials.log: database path/size, token length, `clearCachedToken()` calls, query method selection
  - Tracker.log: `activePollId` assignment confirmation, snapshot save confirmation

**Bug 修复**

- 修复轮询过期检查竞态 Bug：SKIPPED 的轮询不再覆盖 `_activePollId`，解决了所有成功获取的数据被判定为"已过期"而丢弃、UI 永远不刷新的问题。
- 修复手动 Token 不生效的 Bug：当自动获取的 Token 过期（API 返回 401）时，重试现在会正确 fallback 到用户手动设置的 Token，而不是反复使用同一个过期 Token。

**优化**

- 增强各日志通道的诊断输出：
  - Extension.log：启动时输出插件版本号、平台、关键配置
  - Monitor.log：Token 来源（自动/手动）、401 重试详情、子 API 具体失败环节
  - Credentials.log：数据库路径/大小、Token 长度、clearCachedToken 调用记录
  - Tracker.log：activePollId 设置确认、snapshot 保存确认

### v1.2.4

**Security Fixes**

- Fixed several security vulnerabilities

**安全修复**

- 修复了若干安全问题

### v1.2.3

**Enhancements**

- Show a notification popup when Max Mode is enabled, so users are aware of the mode switch
- When multiple Cursor windows are open, each monitored alert value is only notified once across all instances, preventing duplicate alert popups

**优化**

- Max Mode 开启时弹窗提示，让用户明确感知模式切换
- 多开 Cursor 窗口时，同一个监控值只会提示一次，避免重复弹窗

### v1.2.2

**Enhancements**

- Smarter reset countdown granularity:
  - \>= 1 day: shows days + hours (e.g., "8d 12h")
  - < 1 day: shows hours + minutes (e.g., "3h 25m")
  - < 1 hour: shows minutes + seconds (e.g., "45m 30s")

**优化**

- 重置倒计时智能分级显示：
  - \>= 1 天：显示天+小时（如"8天12小时"）
  - < 1 天：显示小时+分钟（如"3小时25分钟"）
  - < 1 小时：显示分+秒（如"45分30秒"）

### v1.2.1

**Bug Fixes**

- Fixed false "Included Requests increased by 875" alerts when team API temporarily fails: `numRequests` (all types, 1375) was used as fallback instead of `fastPremiumRequests` (premium only, 500), creating a phantom jump of 875
- When team data fetch fails, now preserves the previous successful `includedUsed` and `onDemandSpent` values instead of falling back to unreliable `numRequests`
- Alerts for `includedRequests` and `onDemandSpending` are now skipped when team data source is unreliable (either current or previous poll)

**修复**

- 修复团队 API 偶然失败时触发"Included Requests 增长了 875"的假警报：`numRequests`（含全部类型=1375）被用作回退，与 `fastPremiumRequests`（仅 premium=500）混用导致数值跳变
- 团队数据获取失败时，保留上次成功的 `includedUsed` 和 `onDemandSpent` 值，不再回退到不可靠的 `numRequests`
- 当前或上次的团队数据不可靠时，跳过 `includedRequests` 和 `onDemandSpending` 提醒

### v1.2.0

**Bug Fixes**

- Fixed polling getting permanently stuck after long idle periods: `_polling` flag would stay `true` forever when HTTP response body reading hangs (e.g., network drops mid-transfer, machine sleep). Root cause: the socket timeout listener was removed after receiving response headers, leaving no timeout protection for response body reading.
- Added three-layer protection against stuck polling:
  1. **Response body timeout** — Keep socket timeout active during response body reading; use `settled` flag and `res.resume()` to prevent Promise leaks
  2. **Overall poll timeout** — `fetchUsage()` wrapped in 90-second hard timeout via `Promise.race`
  3. **Stale poll detection** — Auto-reset `_polling` if previous poll has been running for over 120 seconds

**Enhancements**

- Reset countdown now shows hours alongside days (e.g., "8d 12h" instead of "8 days")

**修复**

- 修复长时间运行后轮询永久卡死的问题：当 HTTP 响应体读取挂起（网络中断、机器休眠等）时，`_polling` 标志永远为 `true`，导致后续所有轮询被跳过。根因是收到响应头后移除了超时监听器，响应体读取阶段无超时保护。
- 三层防护机制：
  1. **响应体超时** — 保持超时监听器在响应体读取期间有效，添加 `settled` 标志和 `res.resume()` 防止 Promise 泄露
  2. **总超时保护** — `fetchUsage()` 用 `Promise.race` 包裹 90 秒硬超时
  3. **卡死检测** — 上次轮询超过 120 秒自动重置 `_polling`

**优化**

- 重置倒计时增加小时显示（如"8天12小时"替代"8天"）

### v1.1.8

**Bug Fixes**

- Set `extensionKind` to `ui` so the extension runs in the local UI extension host. This fixes session auto-detection when using Remote SSH (the remote host has no local Cursor `state.vscdb`).

**Changes**

- Documented Remote SSH / WSL / Dev Containers behavior in README: install the extension locally; credential auto-detection uses the local Cursor data path.
- Recommended workflow: use **Cursor: Install from VSIX** or `cursor --install-extension path/to.vsix` on the **local** machine when using remote workspaces.

**修复**

- 将 `extensionKind` 设为 `ui`，使扩展在本地 UI 扩展宿主中运行，修复 SSH Remote 等场景下无法读取本机 Cursor 会话、自动获取凭证失败的问题。

**变更**

- README 补充远程开发说明：SSH / WSL / Dev Containers 下请在**本机**安装扩展；自动读取会话依赖本机 Cursor 数据路径。
- 建议通过本机 **从 VSIX 安装** 或命令行 `cursor --install-extension xxx.vsix` 安装远程工作区场景下的扩展。

### v1.1.0

**Bug Fixes**

- Fixed new usage request detection: now uses timestamp comparison instead of array length, which was always capped by `displayCount`
- Fixed total token change detection: only compares tokens of events present in both snapshots, excluding noise from new/dropped events
- Added alert dialog anti-stacking: only one alert dialog shows at a time, preventing multiple modals from piling up
- Fixed config change listener memory leak (missing disposal)
- Added HTTP request timeout (30s) to prevent polling from getting permanently blocked
- Added error handling for initial poll and alert dialog promise rejection

**Changes**

- Renamed "New AI sessions" to "New usage requests" in all UI text

**修复**

- 修复新增调用请求检测：改用 timestamp 比较识别新事件，而非依赖数组长度（受 `displayCount` 限制始终不变）
- 修复 Token 总量变化检测：只比较两次快照中都存在的事件的 token 变化，排除新增/滚出事件的干扰
- 新增弹窗防堆积：同时只显示一个提醒弹窗，防止多个 modal 对话框堆积
- 修复配置变更监听器内存泄漏（未加入 dispose 列表）
- 添加 HTTP 请求 30 秒超时，防止网络卡死导致轮询永久阻塞
- 添加初始轮询和弹窗 Promise rejection 的错误处理

**变更**

- 将"新增 AI 会话"重命名为"新增调用请求"

---

## Acknowledgements / 致谢

This project is inspired by [cursor-usage-vscode-extension](https://github.com/YossiSaadi/cursor-usage-vscode-extension) by [@YossiSaadi](https://github.com/YossiSaadi). Thank you for the great work!

本项目灵感来源于 [@YossiSaadi](https://github.com/YossiSaadi) 的 [cursor-usage-vscode-extension](https://github.com/YossiSaadi/cursor-usage-vscode-extension)，感谢原作者的优秀工作！

---

**License**: MIT
