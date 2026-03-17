# Cursor Usage Monitor 插件使用指南

## 一、简介

Cursor Usage Monitor 是一款 Cursor IDE 扩展插件，在侧边栏实时显示 Cursor AI 的用量数据，让你无需打开网页即可随时掌握本月用量和每次对话的消耗详情。

## 二、功能特性

- 本月汇总：显示 Included Requests 和 On-Demand Usage，附带重置倒计时
- 最近消耗：逐条显示每次 AI 对话的模型、Tokens、请求数和费用
- 自动刷新：可配置的轮询间隔（默认 3 秒）
- 可展开详情：点击记录查看 Tokens 输入/输出、请求数和费用明细
- 隐藏项目：右键可隐藏单个指标（如 Included Requests 用完后隐藏）
- 状态栏固定：将指标固定到底部状态栏，不占用项目树空间
- 用量提醒：可配置的阈值提醒，超出时弹窗通知
- 右键菜单：快捷配置显示条数、刷新间隔和 Token
- 中英文双语：自动跟随 IDE 语言设置

## 三、安装方法

### 方式一：VSIX 安装

1. 获取 cursor-usage-monitor-1.0.0.vsix 文件
2. 打开 Cursor IDE
3. 按 Ctrl+Shift+P 打开命令面板
4. 输入 Extensions: Install from VSIX...
5. 选择 .vsix 文件，等待安装
6. Ctrl+Shift+P → Developer: Reload Window 重新加载

### 方式二：源码构建

在项目目录下执行：

```
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

生成的 .vsix 文件按方式一安装即可。

## 四、首次使用

### 4.1 获取 Session Token

1. 用浏览器打开 cursor.com 并登录
2. 按 F12 打开开发者工具
3. 进入 Application → Cookies → https://cursor.com
4. 找到 WorkosCursorSessionToken，复制完整值

### 4.2 设置 Token

1. 在侧边栏找到"Cursor 用量"视图
2. 点击标题栏右侧的钥匙图标
3. 在弹出的输入框中粘贴 Token 值
4. 按回车确认

## 五、界面说明

### 5.1 本月汇总

标题行显示重置倒计时（距下次重置的天数），展开后包含：

- Included Requests：包含请求的已用/上限数量（如 500/500）
- On-Demand Usage：按需用量的美元金额（如 $37.20/$200）

颜色指示用量状态：绿色表示低于 40%，黄色为 40%-70%，红色超过 70%。

### 5.2 最近消耗

默认显示最近 5 条 AI 对话消耗记录。

每条记录主行显示时间、模型名称和类型标签（On-Demand / Included）。

点击展开后可查看：

- Tokens：总消耗 Token 数（可选显示输入/输出明细）
- Requests：请求数
- 费用：本次消耗费用

### 5.3 隐藏项目

右键点击 Included Requests 或 On-Demand Usage 可选择"隐藏此项"。
右键点击"本月汇总"可选择"显示全部项"恢复所有隐藏项。

### 5.4 状态栏固定

右键点击 Included Requests 或 On-Demand Usage 可选择"固定到状态栏"。
固定后在 Cursor 底部状态栏会显示对应数据，不占用项目树空间。
可以同时隐藏侧边栏项并固定到状态栏，实现只在底部显示。

## 六、用量提醒

### 6.1 配置提醒

1. 点击标题栏的铃铛图标
2. 选择"开启提醒"
3. 选择"选择监控项"，勾选需要监控的指标
4. 选择"设置阈值"，为每个监控项设置触发值

### 6.2 可监控项

| 监控项 | 说明 | 默认阈值 |
| --- | --- | --- |
| 新增 AI 会话 | 检测到新的对话记录 | 1 |
| Included Requests 变化 | 包含请求数增长 | 10 |
| On-Demand 花费变化 | 按需花费增长（美元） | 1.0 |
| Token 总消耗变化 | Token 消耗增长 | 100000 |

所有阈值均可设为 0，设为 0 时任何正向变化都会触发提醒。

## 七、右键菜单操作

| 操作位置 | 菜单项 | 功能说明 |
| --- | --- | --- |
| 标题栏 | 设置 Session Token | 输入或修改认证 Token |
| 标题栏 | 刷新 Cursor 用量 | 手动刷新数据 |
| 标题栏 | 配置用量提醒 | 设置提醒开关、监控项和阈值 |
| "本月汇总"行 | 设置刷新间隔 | 调整自动刷新间隔 |
| "本月汇总"行 | 显示全部项 | 恢复所有隐藏的项目 |
| Included/On-Demand 项 | 隐藏此项 | 在侧边栏隐藏此项 |
| Included/On-Demand 项 | 固定到状态栏 | 固定到底部状态栏显示 |
| Included/On-Demand 项 | 从状态栏移除 | 取消状态栏固定 |
| "最近消耗"行 | 设置显示条数 | 调整显示的记录数量 |
| "最近消耗"行 | 设置刷新间隔 | 调整自动刷新间隔 |
| Tokens 行 | 切换 Tokens 详情 | 显示或隐藏输入输出 Token 明细 |

## 八、配置项

在 Cursor 设置中搜索 cursorUsageMonitor 可修改以下配置：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| displayCount | 5 | 显示最近用量记录条数 |
| pollingInterval | 3 | 自动刷新间隔（秒） |
| idleInterval | 60 | 空闲时的刷新间隔（秒） |
| showTokenDetail | false | 是否显示 Token 输入/输出明细 |
| sessionToken | 空 | 手动设置 Session Token |
| hiddenItems | 空 | 在侧边栏隐藏的项目 |
| statusBarItems | 空 | 固定到状态栏的项目 |
| alertEnabled | false | 启用用量变化提醒 |
| alertItems | newSession | 提醒监控项 |
| alertThreshold.* | 各不相同 | 各项提醒阈值 |

## 九、常见问题

### Q1：数据不显示怎么办？

检查 Token 是否正确设置。点击标题栏钥匙图标重新输入 Token。

### Q2：Token 从哪里获取？

浏览器打开 cursor.com → F12 → Application → Cookies → 复制 WorkosCursorSessionToken 的值。

### Q3：如何调整显示条数？

右键点击"最近消耗"行 → 设置显示条数 → 输入 1-50 的数字。

### Q4：如何固定到状态栏？

右键点击 Included Requests 或 On-Demand Usage → 固定到状态栏。固定后底部状态栏会实时显示数据。

### Q5：如何设置用量提醒？

点击标题栏铃铛图标 → 开启提醒 → 选择监控项 → 设置阈值。

### Q6：支持哪些语言？

支持中文（简体）和英文，自动跟随 Cursor IDE 的语言设置。

### Q7：如何查看调试日志？

Ctrl+Shift+P → Output: Show Output Channel → 选择 "Cursor Usage Monitor - Tracker"。
