# Cursor Usage Monitor

[English](#english) | [中文](#中文)

---

## English

A VS Code / Cursor IDE extension that displays your Cursor AI usage directly in the sidebar. Monitor your token consumption, request counts, costs, and usage limits at a glance.

### Features

- **Monthly Summary** — View Included Requests and On-Demand Usage with reset countdown
- **Recent Usage** — Detailed per-conversation breakdown: model, tokens, requests, and cost
- **Auto Refresh** — Configurable polling interval (default: 3 seconds)
- **Expandable Details** — Click any usage entry to see tokens, requests, and cost breakdown
- **Token I/O Toggle** — Optionally show input/output token breakdown (right-click Tokens row)
- **Context Menus** — Right-click to configure display count, polling interval, and session token
- **Hide Items** — Right-click to hide individual items (e.g., Included Requests)
- **Status Bar** — Pin items to the bottom status bar for always-visible monitoring
- **Usage Alerts** — Configurable notifications when usage changes exceed thresholds
- **i18n** — Full English and Chinese (Simplified) localization

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

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `displayCount` | 5 | Number of recent usage entries to display |
| `pollingInterval` | 3 | Polling interval in seconds |
| `idleInterval` | 60 | Idle polling interval in seconds |
| `showTokenDetail` | false | Show input/output token breakdown |
| `hiddenItems` | [] | Items hidden from sidebar (includedRequests, onDemandUsage) |
| `statusBarItems` | [] | Items pinned to status bar |
| `alertEnabled` | false | Enable usage change alerts |
| `alertItems` | ["newSession"] | Items to monitor for alerts |
| `alertThreshold.*` | varies | Threshold values for each alert type |

### Sidebar Display

```
📊 Monthly Summary (Reset in: 8 days)
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
- **自动刷新** — 可配置的轮询间隔（默认 3 秒）
- **可展开详情** — 点击任意用量记录查看 Tokens、请求数和费用明细
- **输入/输出切换** — 右键 Tokens 行可切换显示输入/输出 Token 明细
- **右键菜单** — 右键可配置显示条数、刷新间隔和 Session Token
- **隐藏项目** — 右键可隐藏单个项目（如 Included Requests 用完后隐藏）
- **状态栏固定** — 将项目固定到底部状态栏，不占用项目树空间
- **用量提醒** — 可配置的通知，当用量变化超过阈值时弹窗提醒
- **国际化** — 完整的中英文本地化支持

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

### 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `displayCount` | 5 | 显示最近用量记录条数 |
| `pollingInterval` | 3 | 轮询间隔（秒） |
| `idleInterval` | 60 | 空闲时的轮询间隔（秒） |
| `showTokenDetail` | false | 是否显示 Token 输入/输出明细 |
| `hiddenItems` | [] | 侧边栏隐藏的项目 |
| `statusBarItems` | [] | 固定到状态栏的项目 |
| `alertEnabled` | false | 启用用量变化提醒 |
| `alertItems` | ["newSession"] | 提醒监控项 |
| `alertThreshold.*` | 各不相同 | 各项提醒阈值 |

### 侧边栏显示效果

```
📊 本月汇总（重置倒计时：8天）
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

### 从源码构建

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

---

## Changelog / 更新日志

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
