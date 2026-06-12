import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync, spawn, ChildProcess } from "child_process";
import { UsageTracker, AlertChange } from "./usageTracker";
import { getDbPath } from "./api";
import { UsageTreeProvider, MaxModeDecorationProvider } from "./treeView";
import { initSecretStorage, storeSecretToken, deleteSecretToken, getSecretToken } from "./api";

let ALERT_LOCK_FILE = "";
let MAX_MODE_LOCK_FILE = "";
let BLOCK_STATE_FILE = "";
const ALERT_DEDUPE_MS = 60000;
const ALERT_JITTER_MS = 2000;
const MIN_POLLING_INTERVAL_S = 10;
const MAX_BACKOFF_MS = 300000;

let pollTimer: NodeJS.Timeout | undefined;
let tracker: UsageTracker;
let treeProvider: UsageTreeProvider;

const statusBarItems: Map<string, vscode.StatusBarItem> = new Map();

function getAlertLabel(type: string): string {
    const map: Record<string, string> = {
        newSession: vscode.l10n.t("New usage requests"),
        includedRequests: vscode.l10n.t("Included Requests change"),
        onDemandSpending: vscode.l10n.t("On-Demand spending change"),
        totalTokens: vscode.l10n.t("Total Token consumption change"),
    };
    return map[type] || type;
}

function getItemLabel(id: string): string {
    const map: Record<string, string> = {
        includedRequests: "Included Requests",
        onDemandUsage: "On-Demand Usage",
        maxMode: "Max Mode",
    };
    return map[id] || id;
}

function getSectionLabel(id: string): string {
    const map: Record<string, string> = {
        summarySection: vscode.l10n.t("Monthly Summary"),
        recentSection: vscode.l10n.t("Recent Usage"),
    };
    return map[id] || id;
}

function formatAlertMessage(alert: AlertChange): string {
    switch (alert.type) {
        case "newSession":
            return vscode.l10n.t("Detected {0} new usage request(s)", alert.delta);
        case "includedRequests":
            return vscode.l10n.t("Included Requests increased by {0}", alert.delta);
        case "onDemandSpending":
            return vscode.l10n.t("On-Demand spending increased by ${0}", alert.delta.toFixed(2));
        case "totalTokens": {
            const formatted = alert.delta >= 10000
                ? `${(alert.delta / 10000).toFixed(1)}万`
                : alert.delta.toLocaleString();
            return vscode.l10n.t("Token consumption increased by {0}", formatted);
        }
        default:
            return "";
    }
}

function updateStatusBar() {
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const pinnedItems = config.get<string[]>("statusBarItems", []);
    const snapshot = tracker.lastSnapshot;

    for (const [id, item] of statusBarItems) {
        if (!pinnedItems.includes(id) || !snapshot) {
            item.hide();
        }
    }

    if (!snapshot) return;

    for (const id of pinnedItems) {
        let sbItem = statusBarItems.get(id);
        if (!sbItem) {
            sbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            statusBarItems.set(id, sbItem);
        }

        if (id === "includedRequests") {
            sbItem.text = `$(graph) Incl: ${snapshot.includedUsed}/${snapshot.includedLimit}`;
            sbItem.tooltip = `Included Requests: ${snapshot.includedUsed}/${snapshot.includedLimit}`;
        } else if (id === "onDemandUsage") {
            const spent = `$${snapshot.onDemandSpentDollars.toFixed(2)}`;
            const limit = snapshot.onDemandLimitDollars > 0 ? `/$${snapshot.onDemandLimitDollars}` : "";
            sbItem.text = `$(zap) OD: ${spent}${limit}`;
            sbItem.tooltip = `On-Demand Usage: ${spent}${limit}`;
        } else if (id === "maxMode") {
            const maxInfo = tracker.maxModeInfo;
            if (maxInfo) {
                sbItem.text = maxInfo.maxMode ? `$(flame) Max: ON` : `$(circle-outline) Max: OFF`;
                sbItem.tooltip = maxInfo.maxMode
                    ? `Max Mode: ON (${maxInfo.modelName})`
                    : `Max Mode: OFF`;
            } else {
                sbItem.text = `$(question) Max: ?`;
                sbItem.tooltip = "Max Mode: Unknown";
            }
        }

        sbItem.show();
    }
}

/**
 * 多实例弹窗去重：随机抖动 + 文件锁。
 * 抖动使各实例错开检查时间，避免同时读到旧锁文件后全部弹窗。
 */
async function tryAcquireAlertLock(lockFile: string, dedupeMs = ALERT_DEDUPE_MS): Promise<boolean> {
    const jitter = Math.floor(Math.random() * ALERT_JITTER_MS);
    await new Promise(resolve => setTimeout(resolve, jitter));

    try {
        const now = Date.now();
        if (fs.existsSync(lockFile)) {
            const content = fs.readFileSync(lockFile, "utf-8").trim();
            const lastTime = parseInt(content, 10);
            if (!isNaN(lastTime) && now - lastTime < dedupeMs) {
                extLog.appendLine(`[${new Date().toISOString()}] 跳过弹窗：其他实例已在 ${now - lastTime}ms 前弹出 (lock=${path.basename(lockFile)})`);
                return false;
            }
        }
        fs.writeFileSync(lockFile, String(now), "utf-8");
        return true;
    } catch {
        return true;
    }
}

function writeBlockState(maxModeOn: boolean) {
    if (!BLOCK_STATE_FILE) return;
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const blockEnabled = config.get<boolean>("blockMaxModeChat", false);
    try {
        fs.writeFileSync(BLOCK_STATE_FILE, JSON.stringify({
            blockEnabled,
            maxModeOn,
            lang: vscode.env.language,
            updatedAt: Date.now(),
        }), { encoding: "utf-8", mode: 0o600 });
    } catch { /* ignore */ }
}

function getCursorUserDir(): string {
    return path.join(os.homedir(), ".cursor");
}

const HOOK_SCRIPT_NAME = "cursor-usage-monitor-block-max-mode.js";
const HOOK_CMD_NAME = "cursor-usage-monitor-block-max-mode.cmd";

function getHookScriptPath(): string {
    return path.join(getCursorUserDir(), "hooks", HOOK_SCRIPT_NAME);
}

function getHookCmdPath(): string {
    return path.join(getCursorUserDir(), "hooks", HOOK_CMD_NAME);
}

function getHooksJsonPath(): string {
    return path.join(getCursorUserDir(), "hooks.json");
}

function isOurHook(h: unknown): boolean {
    if (!h || typeof h !== "object") return false;
    const cmd = String((h as Record<string, unknown>).command || "");
    return cmd === `node ./hooks/${HOOK_SCRIPT_NAME}`
        || cmd === `./hooks/${HOOK_CMD_NAME}`
        || cmd === `./hooks/${HOOK_SCRIPT_NAME}`
        || cmd.endsWith(`/${HOOK_SCRIPT_NAME}`)
        || cmd.endsWith(`/${HOOK_CMD_NAME}`)
        || cmd.endsWith(`\\${HOOK_SCRIPT_NAME}`)
        || cmd.endsWith(`\\${HOOK_CMD_NAME}`);
}

function getHookScriptContent(): string {
    const stateFilePath = JSON.stringify(BLOCK_STATE_FILE);
    const logFilePath = JSON.stringify(path.join(path.dirname(BLOCK_STATE_FILE), "hook.log"));
    const MAX_STDIN = 4 * 1024 * 1024;
    return [
        "#!/usr/bin/env node",
        '"use strict";',
        'const fs = require("fs");',
        "",
        `const LOG_FILE = ${logFilePath};`,
        `const STATE_FILE = ${stateFilePath};`,
        `const MAX_STDIN = ${MAX_STDIN};`,
        "",
        "function log(msg) {",
        "    try {",
        "        try { if (fs.statSync(LOG_FILE).size > 1048576) fs.writeFileSync(LOG_FILE, '', { mode: 0o600 }); } catch {}",
        '        const ts = new Date().toISOString();',
        '        fs.appendFileSync(LOG_FILE, ts + " " + msg + "\\n", { mode: 0o600 });',
        "    } catch {}",
        "}",
        "",
        "async function main() {",
        '    let input = "";',
        '    process.stdin.setEncoding("utf-8");',
        "    for await (const chunk of process.stdin) {",
        "        input += chunk;",
        "        if (input.length > MAX_STDIN) { input = input.slice(0, MAX_STDIN); break; }",
        "    }",
        "",
        '    log("Hook invoked, input length=" + input.length);',
        "",
        "    try {",
        "        const stat = fs.statSync(STATE_FILE);",
        "        if (!stat.isFile() || stat.size > 4096) throw new Error('invalid state file');",
        '        const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));',
        "        if (state.blockEnabled === true && state.maxModeOn === true) {",
        '            const zh = (typeof state.lang === "string" && state.lang.startsWith("zh"));',
        '            const msg = zh',
        '                ? "\\u26d4 MAX Mode \\u5df2\\u5f00\\u542f\\uff0c\\u6d88\\u606f\\u5df2\\u88ab Cursor Usage Monitor \\u62e6\\u622a\\u3002\\n\\n\\u89e3\\u9664\\u62e6\\u622a\\uff1a\\n1. \\u5728 Cursor \\u8bbe\\u7f6e\\u4e2d\\u5173\\u95ed MAX Mode\\n2. \\u6216\\u5728\\u63d2\\u4ef6\\u8bbe\\u7f6e\\u4e2d\\u7981\\u7528 [\\u7981\\u6b62 MAX Mode \\u5bf9\\u8bdd]"',
        '                : "\\u26d4 MAX Mode is ON. Message blocked by Cursor Usage Monitor.\\n\\nTo unblock:\\n1. Turn off MAX Mode in Cursor settings\\n2. Or disable [Block MAX Mode Chat] in extension settings";',
        "            const resp = JSON.stringify({ continue: false, user_message: msg });",
        '            log("BLOCKED");',
        "            process.stdout.write(resp);",
        "            return;",
        "        }",
        '        log("ALLOWED");',
        "    } catch (e) {",
        '        log("ERROR: " + (e && e.message || e));',
        "    }",
        "",
        '    process.stdout.write(JSON.stringify({ continue: true }));',
        "}",
        "",
        "main().catch((e) => {",
        '    log("FATAL: " + (e && e.message || e));',
        '    process.stdout.write(JSON.stringify({ continue: true }));',
        "});",
        "",
    ].join("\n");
}

function atomicWriteJson(filePath: string, data: unknown): void {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
}

function backupFile(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, filePath + ".bak");
        }
    } catch { /* best effort */ }
}

function verifyHookIntegrity(): boolean {
    const scriptPath = getHookScriptPath();
    if (!fs.existsSync(scriptPath)) return false;
    try {
        const stat = fs.lstatSync(scriptPath);
        if (stat.isSymbolicLink() || !stat.isFile()) return false;
        const content = fs.readFileSync(scriptPath, "utf-8");
        const expected = getHookScriptContent();
        const actualHash = crypto.createHash("sha256").update(content).digest("hex");
        const expectedHash = crypto.createHash("sha256").update(expected).digest("hex");
        return actualHash === expectedHash;
    } catch {
        return false;
    }
}

function installBlockHook(): void {
    const hooksDir = path.join(getCursorUserDir(), "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });

    const scriptContent = getHookScriptContent();
    fs.writeFileSync(getHookScriptPath(), scriptContent, { mode: 0o700 });

    let hookCommand: string;
    if (process.platform === "win32") {
        const nodePath = process.execPath;
        if (/[&|<>^"%!\r\n]/.test(nodePath)) {
            throw new Error("Node path contains unsafe characters");
        }
        const cmdContent = `@echo off\r\n"${nodePath}" "%~dp0${HOOK_SCRIPT_NAME}"\r\n`;
        fs.writeFileSync(getHookCmdPath(), cmdContent);
        hookCommand = `./hooks/${HOOK_CMD_NAME}`;
    } else {
        const nodePath = process.execPath;
        hookCommand = `"${nodePath}" "./hooks/${HOOK_SCRIPT_NAME}"`;
    }

    const hooksJsonPath = getHooksJsonPath();
    let hooksJson: Record<string, unknown> = { version: 1, hooks: {} };

    if (fs.existsSync(hooksJsonPath)) {
        backupFile(hooksJsonPath);
        try {
            const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
            if (parsed && typeof parsed === "object") {
                hooksJson = parsed;
            }
        } catch {
            extLog.appendLine(`[${new Date().toISOString()}] hooks.json 解析失败，从备份恢复`);
            try {
                const bakPath = hooksJsonPath + ".bak";
                if (fs.existsSync(bakPath)) {
                    const backup = JSON.parse(fs.readFileSync(bakPath, "utf-8"));
                    if (backup && typeof backup === "object") {
                        hooksJson = backup;
                    }
                }
            } catch { /* use fresh */ }
        }
    }

    const hooks = (hooksJson.hooks && typeof hooksJson.hooks === "object") ? hooksJson.hooks as Record<string, unknown> : {};
    hooksJson.hooks = hooks;
    if (!Array.isArray(hooks.beforeSubmitPrompt)) hooks.beforeSubmitPrompt = [];

    hooks.beforeSubmitPrompt = (hooks.beforeSubmitPrompt as unknown[]).filter(
        (h: unknown) => !isOurHook(h)
    );

    (hooks.beforeSubmitPrompt as unknown[]).push({
        command: hookCommand,
        failClosed: false,
    });

    atomicWriteJson(hooksJsonPath, hooksJson);
    extLog.appendLine(`[${new Date().toISOString()}] MAX Mode block hook installed`);
}

function removeBlockHook(): void {
    try { fs.unlinkSync(getHookScriptPath()); } catch { /* ignore */ }
    try { fs.unlinkSync(getHookCmdPath()); } catch { /* ignore */ }

    const hooksJsonPath = getHooksJsonPath();
    if (!fs.existsSync(hooksJsonPath)) return;

    try {
        backupFile(hooksJsonPath);
        const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
        if (Array.isArray(hooksJson.hooks?.beforeSubmitPrompt)) {
            hooksJson.hooks.beforeSubmitPrompt = hooksJson.hooks.beforeSubmitPrompt.filter(
                (h: unknown) => !isOurHook(h)
            );
            if (hooksJson.hooks.beforeSubmitPrompt.length === 0) {
                delete hooksJson.hooks.beforeSubmitPrompt;
            }
            atomicWriteJson(hooksJsonPath, hooksJson);
        }
    } catch { /* ignore */ }
    extLog.appendLine(`[${new Date().toISOString()}] MAX Mode block hook removed`);
}

function isBlockHookInstalled(): boolean {
    const hooksJsonPath = getHooksJsonPath();
    if (!fs.existsSync(hooksJsonPath)) return false;
    try {
        const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
        return hooksJson.hooks?.beforeSubmitPrompt?.some((h: any) => isOurHook(h)) || false;
    } catch {
        return false;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    const extVersion = context.extension?.packageJSON?.version || "unknown";
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    extLog.appendLine(`[${new Date().toISOString()}] 插件启动 v${extVersion}, platform=${process.platform}, pollingInterval=${config.get("pollingInterval", 30)}s, displayCount=${config.get("displayCount", 5)}, alertEnabled=${config.get("alertEnabled", true)}`);

    const safeDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(safeDir, { recursive: true });
    ALERT_LOCK_FILE = path.join(safeDir, "alert.lock");
    MAX_MODE_LOCK_FILE = path.join(safeDir, "maxmode.lock");
    BLOCK_STATE_FILE = path.join(safeDir, "max-mode-block-state.json");

    initSecretStorage(context.secrets);

    // 从 settings.json 迁移明文 token 到 SecretStorage
    await migrateTokenToSecretStorage(context.secrets);

    await migratePollingInterval();

    tracker = new UsageTracker();
    treeProvider = new UsageTreeProvider(tracker);

    const maxModeDecoProvider = new MaxModeDecorationProvider();
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(maxModeDecoProvider));

    const treeView = vscode.window.createTreeView("cursorUsageView", {
        treeDataProvider: treeProvider,
        showCollapseAll: false,
    });
    context.subscriptions.push(treeView);

    tracker.onUpdate = () => {
        treeProvider.refresh();
        maxModeDecoProvider.fireChange();
        updateStatusBar();

        const maxInfo = tracker.maxModeInfo;
        if (maxInfo?.maxMode) {
            treeView.description = "⚠ MAX MODE";
            treeView.badge = { value: 1, tooltip: vscode.l10n.t("Max Mode is ON") };
        } else {
            treeView.description = undefined;
            treeView.badge = undefined;
        }

        const children = treeProvider.getChildren();
        if (children.length > 0) {
            treeView.reveal(children[0], { expand: true, focus: false, select: false })
                .then(undefined, () => {});
        }
    };

    let alertDialogShowing = false;
    let alertLockPending = false;

    tracker.onAlert = (alerts: AlertChange[]) => {
        if (alertDialogShowing || alertLockPending) return;

        alertLockPending = true;
        tryAcquireAlertLock(ALERT_LOCK_FILE).then(acquired => {
            alertLockPending = false;
            if (!acquired || alertDialogShowing) return;

            alertDialogShowing = true;
            const messages = alerts.map(formatAlertMessage);
            const title = vscode.l10n.t("Cursor Usage Alert");
            const detail = messages.join("\n");
            vscode.window.showWarningMessage(
                `⚠️ ${title}`,
                { modal: true, detail },
                vscode.l10n.t("View Settings"),
            ).then((choice) => {
                alertDialogShowing = false;
                if (choice === vscode.l10n.t("View Settings")) {
                    vscode.commands.executeCommand("cursor-usage-monitor.configureAlerts");
                }
            }, () => {
                alertDialogShowing = false;
            });
        });
    };

    // Max Mode 实时监控：启动持久 Python 子进程监听数据库变化
    let lastAlertedMaxScopes = new Set<string>();
    let maxModeWatcherProcess: ChildProcess | undefined;

    const SCOPE_LABELS: Record<string, string> = {
        composer: "Agent",
        "cmd-k": "Cmd+K",
        "background-composer": "Background Agent",
    };

    const WATCHER_SCRIPT = `
import sqlite3, sys, json, time

DB_PATH = sys.argv[1]
INTERVAL = float(sys.argv[2])
KEY = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'

prev = None

while True:
    try:
        c = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        row = c.execute("SELECT value FROM ItemTable WHERE key=?", (KEY,)).fetchone()
        c.close()
        if row:
            d = json.loads(row[0])
            mc = d.get('aiSettings', {}).get('modelConfig', {})
            curr = {}
            for k, v in mc.items():
                if isinstance(v, dict) and 'maxMode' in v:
                    curr[k] = {"maxMode": v["maxMode"], "modelName": v.get("modelName", "unknown")}
            if curr != prev:
                print(json.dumps(curr), flush=True)
                prev = curr
    except Exception:
        pass
    time.sleep(INTERVAL)
`;

    function findPython(): string | null {
        const cmds = os.platform() === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
        for (const cmd of cmds) {
            try {
                let resolved: string;
                if (os.platform() === "win32") {
                    resolved = execFileSync("where.exe", [cmd], { stdio: "pipe", timeout: 5000, windowsHide: true }).toString().trim().split(/\r?\n/)[0];
                } else {
                    resolved = execFileSync("which", [cmd], { stdio: "pipe", timeout: 5000 }).toString().trim();
                }
                if (resolved && path.isAbsolute(resolved)) {
                    execFileSync(resolved, ["--version"], { stdio: "pipe", timeout: 5000, windowsHide: true });
                    return resolved;
                }
            } catch { /* try next */ }
        }
        return null;
    }

    function parseMaxModeStatus(raw: unknown): Record<string, { maxMode: boolean; modelName: string }> | null {
        if (!raw || typeof raw !== "object") return null;
        const result: Record<string, { maxMode: boolean; modelName: string }> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof k !== "string" || k.length > 64) continue;
            if (!v || typeof v !== "object") continue;
            const entry = v as Record<string, unknown>;
            const maxMode = entry.maxMode === true;
            let modelName = String(entry.modelName ?? "unknown").slice(0, 128);
            if (/[\x00-\x1f\x7f]/.test(modelName)) modelName = "unknown";
            result[k] = { maxMode, modelName };
        }
        return Object.keys(result).length > 0 ? result : null;
    }

    function handleMaxModeStatus(status: Record<string, { maxMode: boolean; modelName: string }>) {
        const config = vscode.workspace.getConfiguration("cursorUsageMonitor");

        const monitoredScopes = ["composer", "cmd-k"];
        const enabledScopes: { scope: string; label: string; model: string }[] = [];

        for (const scope of monitoredScopes) {
            const info = status[scope];
            if (info?.maxMode) {
                enabledScopes.push({
                    scope,
                    label: SCOPE_LABELS[scope] || scope,
                    model: info.modelName,
                });
            }
        }

        // maxModeAlert 仅控制弹窗，不影响 UI 同步
        if (config.get<boolean>("maxModeAlert", true)) {
            const newlyEnabled = enabledScopes.filter(s => !lastAlertedMaxScopes.has(s.scope));
            if (newlyEnabled.length > 0) {
                const lines = newlyEnabled.map(s => `• ${s.label}: ${s.model}`).join("\n");
                extLog.appendLine(`[${new Date().toISOString()}] Max Mode 已开启: ${newlyEnabled.map(s => s.scope).join(", ")}`);

                tryAcquireAlertLock(MAX_MODE_LOCK_FILE).then(acquired => {
                    if (!acquired) return;

                    const title = vscode.l10n.t("Max Mode Enabled Warning");
                    const detail = vscode.l10n.t(
                        "Max Mode has been turned ON (model: {0}). This will consume more premium requests. Please confirm before starting a conversation.",
                        lines,
                    );

                    vscode.window.showWarningMessage(
                        `🔥 ${title}`,
                        { modal: true, detail },
                        vscode.l10n.t("Don't remind again"),
                    ).then((choice) => {
                        if (choice === vscode.l10n.t("Don't remind again")) {
                            config.update("maxModeAlert", false, vscode.ConfigurationTarget.Global);
                            vscode.window.showInformationMessage(vscode.l10n.t("Max Mode alert disabled"));
                        }
                    });
                });
            }
        }

        lastAlertedMaxScopes = new Set(enabledScopes.map(s => s.scope));

        // 同步 tracker 的 maxModeInfo，使状态栏/badge 立即反映 Python 监控的最新状态
        const composerInfo = status["composer"];
        tracker.maxModeInfo = composerInfo
            ? { maxMode: composerInfo.maxMode, modelName: composerInfo.modelName, currentMode: tracker.maxModeInfo?.currentMode || "agent" }
            : null;

        writeBlockState(composerInfo?.maxMode === true);

        // 更新 UI 显示
        treeProvider.refresh();
        maxModeDecoProvider.fireChange();
        updateStatusBar();

        // 同步 treeView 的 badge/description
        const maxInfo = tracker.maxModeInfo;
        if (maxInfo?.maxMode) {
            treeView.description = "⚠ MAX MODE";
            treeView.badge = { value: 1, tooltip: vscode.l10n.t("Max Mode is ON") };
        } else {
            treeView.description = undefined;
            treeView.badge = undefined;
        }
    }

    let watcherDisposed = false;
    let watcherRestartTimer: NodeJS.Timeout | undefined;
    let watcherRestartAttempts = 0;
    const MAX_WATCHER_RESTARTS = 10;

    function startMaxModeWatcher() {
        const pythonCmd = findPython();
        if (!pythonCmd) {
            extLog.appendLine(`[${new Date().toISOString()}] Max Mode 监控: 未找到 Python`);
            return;
        }

        const dbPath = getDbPath();
        if (!fs.existsSync(dbPath)) {
            extLog.appendLine(`[${new Date().toISOString()}] Max Mode 监控: 数据库不存在 ${dbPath}`);
            return;
        }

        const scriptFile = path.join(safeDir, "_cursor_usage_max_mode_watcher.py");
        fs.writeFileSync(scriptFile, WATCHER_SCRIPT, { mode: 0o600 });

        const MAX_LINE_BUFFER = 64 * 1024;

        const startProcess = () => {
            if (watcherDisposed || watcherRestartAttempts >= MAX_WATCHER_RESTARTS) {
                if (watcherRestartAttempts >= MAX_WATCHER_RESTARTS) {
                    extLog.appendLine(`[${new Date().toISOString()}] Max Mode 监控已达最大重启次数 ${MAX_WATCHER_RESTARTS}，停止重启`);
                }
                return;
            }
            extLog.appendLine(`[${new Date().toISOString()}] 启动 Max Mode 监控进程: ${pythonCmd}`);
            const proc = spawn(pythonCmd, [scriptFile, dbPath, "1"], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            maxModeWatcherProcess = proc;

            let lineBuffer = "";

            proc.stdout!.on("data", (chunk: Buffer) => {
                if (lineBuffer.length + chunk.length > MAX_LINE_BUFFER) {
                    extLog.appendLine(`[${new Date().toISOString()}] Max Mode watcher: stdout 缓冲溢出，终止进程`);
                    proc.kill();
                    return;
                }
                lineBuffer += chunk.toString();
                const lines = lineBuffer.split("\n");
                lineBuffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const status = parseMaxModeStatus(JSON.parse(trimmed));
                        if (status) {
                            watcherRestartAttempts = 0;
                            handleMaxModeStatus(status);
                        }
                    } catch (e: any) {
                        extLog.appendLine(`[${new Date().toISOString()}] Max Mode 解析错误: ${e.message}`);
                    }
                }
            });

            proc.stderr!.on("data", (chunk: Buffer) => {
                extLog.appendLine(`[${new Date().toISOString()}] Max Mode watcher stderr: ${chunk.toString().trim().slice(0, 500)}`);
            });

            proc.on("exit", (code) => {
                maxModeWatcherProcess = undefined;
                if (!watcherDisposed) {
                    watcherRestartAttempts++;
                    const delay = Math.min(3000 * Math.pow(2, watcherRestartAttempts - 1), 60000);
                    extLog.appendLine(`[${new Date().toISOString()}] Max Mode 监控进程退出 (code=${code})，${delay / 1000}s 后第 ${watcherRestartAttempts} 次重启`);
                    watcherRestartTimer = setTimeout(() => startProcess(), delay);
                }
            });

            proc.on("error", (err) => {
                extLog.appendLine(`[${new Date().toISOString()}] Max Mode 监控进程错误: ${err.message}`);
            });
        };

        startProcess();

        context.subscriptions.push({
            dispose: () => {
                watcherDisposed = true;
                if (watcherRestartTimer) clearTimeout(watcherRestartTimer);
                if (maxModeWatcherProcess) {
                    maxModeWatcherProcess.kill();
                    maxModeWatcherProcess = undefined;
                }
                try { fs.unlinkSync(scriptFile); } catch { /* ignore */ }
            },
        });
    }

    startMaxModeWatcher();
    writeBlockState(tracker.maxModeInfo?.maxMode === true);

    function restoreMaxModeDescription() {
        const maxInfo = tracker.maxModeInfo;
        treeView.description = maxInfo?.maxMode ? "⚠ MAX MODE" : undefined;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.refresh", () => {
            vscode.window.withProgress(
                { location: { viewId: "cursorUsageView" } },
                async () => {
                    try {
                        await tracker.poll(true);
                        treeView.description = vscode.l10n.t("✓ Updated");
                        setTimeout(restoreMaxModeDescription, 2000);
                    } catch (err) {
                        treeView.description = vscode.l10n.t("✗ Failed");
                        setTimeout(restoreMaxModeDescription, 3000);
                        console.error("[CursorUsageMonitor] Refresh error:", err);
                    }
                },
            );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.setToken", async () => {
            const token = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("Enter Cursor Session Token (format: userId%3A%3AaccessToken)"),
                placeHolder: "userId%3A%3AaccessToken",
                password: true,
                ignoreFocusOut: true,
                validateInput: (v) => {
                    if (!v) return null;
                    if (v.length > 4096) return vscode.l10n.t("Token too long");
                    if (/[\x00-\x1f\x7f]/.test(v)) return vscode.l10n.t("Token contains invalid control characters");
                    if (!v.includes("%3A%3A")) return vscode.l10n.t("Invalid format (expected userId%3A%3AaccessToken)");
                    return null;
                },
            });

            if (token !== undefined) {
                if (token) {
                    await storeSecretToken(token);
                } else {
                    await deleteSecretToken();
                }
                vscode.window.showInformationMessage(
                    token ? vscode.l10n.t("Token saved") : vscode.l10n.t("Token cleared")
                );
                await tracker.poll();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.setDisplayCount", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const current = config.get<number>("displayCount", 5);

            const input = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("Set display count (1-50)"),
                value: String(current),
                validateInput: (v) => {
                    const n = parseInt(v);
                    return (isNaN(n) || n < 1 || n > 50)
                        ? vscode.l10n.t("Please enter a number between 1 and 50")
                        : null;
                },
            });

            if (input !== undefined) {
                await config.update("displayCount", parseInt(input), vscode.ConfigurationTarget.Global);
                await tracker.poll();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.setPollingInterval", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const current = config.get<number>("pollingInterval", 30);

            const input = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("Set polling interval in seconds ({0}-60)", MIN_POLLING_INTERVAL_S),
                value: String(current),
                validateInput: (v) => {
                    const n = parseInt(v);
                    return (isNaN(n) || n < MIN_POLLING_INTERVAL_S || n > 60)
                        ? vscode.l10n.t("Please enter a number between {0} and 60", MIN_POLLING_INTERVAL_S)
                        : null;
                },
            });

            if (input !== undefined) {
                await config.update("pollingInterval", parseInt(input), vscode.ConfigurationTarget.Global);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.toggleTokenDetail", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const current = config.get<boolean>("showTokenDetail", false);
            await config.update("showTokenDetail", !current, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                !current ? vscode.l10n.t("Token detail enabled") : vscode.l10n.t("Token detail disabled")
            );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.hideItem", async (item?: any) => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const hidden = config.get<string[]>("hiddenItems", []);

            let itemId: string | undefined;
            if (item?.contextValue) {
                const match = item.contextValue.match(/^summaryChild_(.+)$/);
                if (match) itemId = match[1];
            }

            if (!itemId) {
                const choices = ["includedRequests", "onDemandUsage"]
                    .filter((id) => !hidden.includes(id))
                    .map((id) => ({ label: getItemLabel(id), id }));
                if (choices.length === 0) {
                    vscode.window.showInformationMessage(vscode.l10n.t("All items are already hidden"));
                    return;
                }
                const pick = await vscode.window.showQuickPick(choices, {
                    placeHolder: vscode.l10n.t("Select item to hide"),
                });
                if (!pick) return;
                itemId = pick.id;
            }

            if (!hidden.includes(itemId)) {
                hidden.push(itemId);
                await config.update("hiddenItems", hidden, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    vscode.l10n.t("{0} hidden", getItemLabel(itemId))
                );
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.hideSection", async (item?: any) => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const hidden = config.get<string[]>("hiddenItems", []);
            const ALLOWED_SECTIONS = new Set(["summarySection", "recentSection"]);
            const sectionId = item?.contextValue;
            if (sectionId && ALLOWED_SECTIONS.has(sectionId) && !hidden.includes(sectionId)) {
                hidden.push(sectionId);
                await config.update("hiddenItems", hidden, vscode.ConfigurationTarget.Global);
                const label = getSectionLabel(sectionId);
                vscode.window.showInformationMessage(vscode.l10n.t("{0} hidden", label));
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.hideEvent", async (item?: any) => {
            if (!item?.id) return;
            const match = item.id.match(/^event_(\d+)$/);
            if (!match) return;
            const timestamp = parseInt(match[1]);
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const hiddenTs = config.get<number[]>("hiddenEventTimestamps", []);
            if (!hiddenTs.includes(timestamp)) {
                hiddenTs.push(timestamp);
                await config.update("hiddenEventTimestamps", hiddenTs, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(vscode.l10n.t("{0} hidden", item.label || ""));
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.showAllItems", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            await config.update("hiddenItems", [], vscode.ConfigurationTarget.Global);
            await config.update("hiddenEventTimestamps", [], vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(vscode.l10n.t("All items are now visible"));
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.pinToStatusBar", async (item?: any) => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const pinned = config.get<string[]>("statusBarItems", []);

            let itemId: string | undefined;
            if (item?.contextValue) {
                const match = item.contextValue.match(/^summaryChild_(.+)$/);
                if (match) itemId = match[1];
            }

            if (!itemId) {
                const choices = ["includedRequests", "onDemandUsage", "maxMode"]
                    .filter((id) => !pinned.includes(id))
                    .map((id) => ({ label: getItemLabel(id), id }));
                if (choices.length === 0) {
                    vscode.window.showInformationMessage(vscode.l10n.t("All items are already pinned"));
                    return;
                }
                const pick = await vscode.window.showQuickPick(choices, {
                    placeHolder: vscode.l10n.t("Select item to pin to status bar"),
                });
                if (!pick) return;
                itemId = pick.id;
            }

            if (!pinned.includes(itemId)) {
                pinned.push(itemId);
                await config.update("statusBarItems", pinned, vscode.ConfigurationTarget.Global);
                updateStatusBar();
                vscode.window.showInformationMessage(
                    vscode.l10n.t("{0} pinned to status bar", getItemLabel(itemId))
                );
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.unpinFromStatusBar", async (item?: any) => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const pinned = config.get<string[]>("statusBarItems", []);

            let itemId: string | undefined;
            if (item?.contextValue) {
                const match = item.contextValue.match(/^summaryChild_(.+)$/);
                if (match) itemId = match[1];
            }

            if (!itemId) {
                const choices = pinned.map((id) => ({ label: getItemLabel(id), id }));
                if (choices.length === 0) {
                    vscode.window.showInformationMessage(vscode.l10n.t("No items are pinned"));
                    return;
                }
                const pick = await vscode.window.showQuickPick(choices, {
                    placeHolder: vscode.l10n.t("Select item to unpin from status bar"),
                });
                if (!pick) return;
                itemId = pick.id;
            }

            const idx = pinned.indexOf(itemId);
            if (idx >= 0) {
                pinned.splice(idx, 1);
                await config.update("statusBarItems", pinned, vscode.ConfigurationTarget.Global);
                updateStatusBar();
                vscode.window.showInformationMessage(
                    vscode.l10n.t("{0} unpinned from status bar", getItemLabel(itemId))
                );
            }
        }),
    );

    function updateBlockHookContext() {
        const installed = isBlockHookInstalled();
        vscode.commands.executeCommand("setContext", "cursorUsageMonitor.blockHookInstalled", installed);
        if (installed && !verifyHookIntegrity()) {
            extLog.appendLine(`[${new Date().toISOString()}] Hook 脚本完整性校验失败，重新安装`);
            try {
                installBlockHook();
            } catch (err: unknown) {
                extLog.appendLine(`[${new Date().toISOString()}] Hook 重新安装失败: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    updateBlockHookContext();

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.installBlockHook", async () => {
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t("This will install a Cursor hook that blocks sending messages when MAX Mode is ON. Continue?"),
                vscode.l10n.t("Install"),
                vscode.l10n.t("Cancel"),
            );
            if (choice === vscode.l10n.t("Install")) {
                try {
                    installBlockHook();
                    const cfg = vscode.workspace.getConfiguration("cursorUsageMonitor");
                    await cfg.update("blockMaxModeChat", true, vscode.ConfigurationTarget.Global);
                    writeBlockState(tracker.maxModeInfo?.maxMode === true);
                    updateBlockHookContext();
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("MAX Mode block hook installed successfully")
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Hook install failed: {0}", err.message)
                    );
                }
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.uninstallBlockHook", async () => {
            const choice = await vscode.window.showWarningMessage(
                vscode.l10n.t("This will remove the MAX Mode block hook. Continue?"),
                vscode.l10n.t("Remove"),
                vscode.l10n.t("Cancel"),
            );
            if (choice === vscode.l10n.t("Remove")) {
                try {
                    removeBlockHook();
                    const cfg = vscode.workspace.getConfiguration("cursorUsageMonitor");
                    await cfg.update("blockMaxModeChat", false, vscode.ConfigurationTarget.Global);
                    writeBlockState(tracker.maxModeInfo?.maxMode === true);
                    updateBlockHookContext();
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("MAX Mode block hook removed successfully")
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t("Hook remove failed: {0}", err.message)
                    );
                }
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.configureAlerts", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
        const enabled = config.get<boolean>("alertEnabled", true);
        const currentItems = config.get<string[]>("alertItems", ["newSession", "includedRequests", "onDemandSpending"]);

            const maxModeAlertOn = config.get<boolean>("maxModeAlert", true);

            const toggleChoice = await vscode.window.showQuickPick(
                [
                    {
                        label: maxModeAlertOn
                            ? `$(flame) ${vscode.l10n.t("Disable Max Mode alert")}`
                            : `$(flame) ${vscode.l10n.t("Enable Max Mode alert")}`,
                        description: maxModeAlertOn
                            ? vscode.l10n.t("Currently: ON")
                            : vscode.l10n.t("Currently: OFF"),
                        id: "toggleMaxMode",
                    },
                    {
                        label: enabled
                            ? `$(bell-slash) ${vscode.l10n.t("Disable alerts")}`
                            : `$(bell) ${vscode.l10n.t("Enable alerts")}`,
                        id: "toggle",
                    },
                    {
                        label: `$(checklist) ${vscode.l10n.t("Select monitoring items")}`,
                        id: "selectItems",
                    },
                    {
                        label: `$(settings-gear) ${vscode.l10n.t("Set thresholds")}`,
                        id: "setThresholds",
                    },
                ],
                { placeHolder: vscode.l10n.t("Configure usage alerts") }
            );

            if (!toggleChoice) return;

            if (toggleChoice.id === "toggleMaxMode") {
                const newVal = !maxModeAlertOn;
                await config.update("maxModeAlert", newVal, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    newVal
                        ? vscode.l10n.t("Max Mode alert enabled")
                        : vscode.l10n.t("Max Mode alert disabled")
                );
            } else if (toggleChoice.id === "toggle") {
                await config.update("alertEnabled", !enabled, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    !enabled
                        ? vscode.l10n.t("Alerts enabled")
                        : vscode.l10n.t("Alerts disabled")
                );
            } else if (toggleChoice.id === "selectItems") {
                const allItems = ["newSession", "includedRequests", "onDemandSpending", "totalTokens"];
                const picks = allItems.map((id) => ({
                    label: getAlertLabel(id),
                    id,
                    picked: currentItems.includes(id),
                }));

                const selected = await vscode.window.showQuickPick(picks, {
                    canPickMany: true,
                    placeHolder: vscode.l10n.t("Select items to monitor"),
                });

                if (selected) {
                    await config.update(
                        "alertItems",
                        selected.map((s) => s.id),
                        vscode.ConfigurationTarget.Global
                    );
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Monitoring items updated ({0} selected)", selected.length)
                    );
                }
            } else if (toggleChoice.id === "setThresholds") {
                const thresholdItems = [
                    { id: "newSession", label: getAlertLabel("newSession"), configKey: "alertThreshold.newSession", unit: "", min: 0, max: 100 },
                    { id: "includedRequests", label: getAlertLabel("includedRequests"), configKey: "alertThreshold.includedRequests", unit: " reqs", min: 0, max: 1000 },
                    { id: "onDemandSpending", label: getAlertLabel("onDemandSpending"), configKey: "alertThreshold.onDemandSpending", unit: " $", min: 0, max: 100 },
                    { id: "totalTokens", label: getAlertLabel("totalTokens"), configKey: "alertThreshold.totalTokens", unit: " tokens", min: 0, max: 10000000 },
                ];

                const thresholdPick = await vscode.window.showQuickPick(
                    thresholdItems.map((t) => ({
                        label: t.label,
                        description: `${vscode.l10n.t("Current")}: ${config.get<number>(t.configKey, 0)}${t.unit}`,
                        id: t.id,
                    })),
                    { placeHolder: vscode.l10n.t("Select threshold to configure") }
                );

                if (!thresholdPick) return;

                const item = thresholdItems.find((t) => t.id === thresholdPick.id)!;
                const current = config.get<number>(item.configKey, 0);

                const pollingSeconds = config.get<number>("pollingInterval", 30);
                const input = await vscode.window.showInputBox({
                    prompt: `${item.label} ${vscode.l10n.t("threshold (change per {0}s poll cycle)", pollingSeconds)} (${item.min}-${item.max})`,
                    value: String(current),
                    validateInput: (v) => {
                        const n = parseFloat(v);
                        return (isNaN(n) || n < item.min || n > item.max)
                            ? vscode.l10n.t("Please enter a value between {0} and {1}", item.min, item.max)
                            : null;
                    },
                });

                if (input !== undefined) {
                    await config.update(item.configKey, parseFloat(input), vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t("Threshold updated: {0} = {1}", item.label, input)
                    );
                }
            }
        }),
    );

    tracker.poll().catch((err) => console.error("[CursorUsageMonitor] Initial poll error:", err));
    startPolling();
    updateStatusBar();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("cursorUsageMonitor")) {
                treeProvider.refresh();
                maxModeDecoProvider.fireChange();
                updateStatusBar();
                startPolling();
            }
            if (e.affectsConfiguration("cursorUsageMonitor.blockMaxModeChat")) {
                writeBlockState(tracker.maxModeInfo?.maxMode === true);
            }
        }),
    );
}

const extLog = vscode.window.createOutputChannel("Cursor Usage Monitor - Extension");

function startPolling() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
    }

    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const baseIntervalMs = Math.max(MIN_POLLING_INTERVAL_S, Math.min(60, config.get<number>("pollingInterval", 30) || 30)) * 1000;

    extLog.appendLine(`[${new Date().toISOString()}] 启动轮询定时器，基础间隔=${baseIntervalMs}ms`);

    function scheduleNext() {
        const failures = tracker.consecutiveFailures;
        let delay = baseIntervalMs;
        if (failures > 0) {
            const multiplier = Math.pow(2, Math.min(failures - 1, 6));
            delay = Math.min(baseIntervalMs * multiplier, MAX_BACKOFF_MS);
            extLog.appendLine(`[${new Date().toISOString()}] 指数退避: 连续失败 ${failures} 次，下次轮询间隔 ${Math.round(delay / 1000)}s`);
        }

        pollTimer = setTimeout(async () => {
            try {
                await tracker.poll();
            } catch (err) {
                extLog.appendLine(`[${new Date().toISOString()}] 轮询出错: ${err}`);
            }
            scheduleNext();
        }, delay);
    }

    scheduleNext();
}

async function migrateTokenToSecretStorage(secrets: vscode.SecretStorage): Promise<void> {
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const TOKEN_RE = /^[A-Za-z0-9._~%:+-]+$/;

    const scopes: { token: string | undefined; target: vscode.ConfigurationTarget }[] = [
        { token: config.inspect<string>("sessionToken")?.globalValue, target: vscode.ConfigurationTarget.Global },
        { token: config.inspect<string>("sessionToken")?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
        { token: config.inspect<string>("sessionToken")?.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
    ];

    for (const { token, target } of scopes) {
        if (!token) continue;
        const existing = await secrets.get("cursorUsageMonitor.sessionToken");
        if (!existing && TOKEN_RE.test(token) && token.includes("%3A%3A") && token.length <= 4096) {
            await secrets.store("cursorUsageMonitor.sessionToken", token);
            extLog.appendLine("已将 sessionToken 迁移到 SecretStorage");
        }
        await config.update("sessionToken", undefined, target);
        extLog.appendLine(`已清除作用域 ${target} 中的明文 sessionToken`);
    }
}

async function migratePollingInterval(): Promise<void> {
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const scopes: { value: number | undefined; target: vscode.ConfigurationTarget }[] = [
        { value: config.inspect<number>("pollingInterval")?.globalValue, target: vscode.ConfigurationTarget.Global },
        { value: config.inspect<number>("pollingInterval")?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
        { value: config.inspect<number>("pollingInterval")?.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
    ];

    for (const { value, target } of scopes) {
        if (value !== undefined && value < MIN_POLLING_INTERVAL_S) {
            await config.update("pollingInterval", MIN_POLLING_INTERVAL_S, target);
            extLog.appendLine(`已将作用域 ${target} 中的 pollingInterval 从 ${value}s 提升到 ${MIN_POLLING_INTERVAL_S}s`);
        }
    }
}

export function deactivate() {
    if (pollTimer) {
        clearTimeout(pollTimer);
    }
    for (const item of statusBarItems.values()) {
        item.dispose();
    }
    statusBarItems.clear();
    const { clearCachedToken } = require("./credentials");
    clearCachedToken();
}
