import * as vscode from "vscode";
import { UsageTracker, AlertChange } from "./usageTracker";
import { UsageTreeProvider } from "./treeView";

let pollTimer: NodeJS.Timeout | undefined;
let tracker: UsageTracker;
let treeProvider: UsageTreeProvider;

const statusBarItems: Map<string, vscode.StatusBarItem> = new Map();

function getAlertLabel(type: string): string {
    const map: Record<string, string> = {
        newSession: vscode.l10n.t("New AI sessions"),
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
    };
    return map[id] || id;
}

function formatAlertMessage(alert: AlertChange): string {
    switch (alert.type) {
        case "newSession":
            return vscode.l10n.t("Detected {0} new AI session(s)", alert.delta);
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
        }

        sbItem.show();
    }
}

export function activate(context: vscode.ExtensionContext) {
    tracker = new UsageTracker();
    treeProvider = new UsageTreeProvider(tracker);

    const treeView = vscode.window.createTreeView("cursorUsageView", {
        treeDataProvider: treeProvider,
        showCollapseAll: false,
    });
    context.subscriptions.push(treeView);

    tracker.onUpdate = () => {
        treeProvider.refresh();
        updateStatusBar();
    };

    tracker.onAlert = (alerts: AlertChange[]) => {
        const messages = alerts.map(formatAlertMessage);
        const title = vscode.l10n.t("Cursor Usage Alert");
        const detail = messages.join("\n");
        vscode.window.showWarningMessage(
            `⚠️ ${title}`,
            { modal: true, detail },
            vscode.l10n.t("View Settings"),
        ).then((choice) => {
            if (choice === vscode.l10n.t("View Settings")) {
                vscode.commands.executeCommand("cursor-usage-monitor.configureAlerts");
            }
        });
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.refresh", () => {
            tracker.poll(true).catch((err) => console.error("[CursorUsageMonitor] Refresh error:", err));
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.setToken", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const current = config.get<string>("sessionToken", "");

            const token = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("Enter Cursor Session Token (format: userId%3A%3AaccessToken)"),
                placeHolder: "userId%3A%3AaccessToken",
                value: current,
                password: true,
                ignoreFocusOut: true,
            });

            if (token !== undefined) {
                await config.update("sessionToken", token, vscode.ConfigurationTarget.Global);
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
            const current = config.get<number>("pollingInterval", 3);

            const input = await vscode.window.showInputBox({
                prompt: vscode.l10n.t("Set polling interval in seconds (1-60)"),
                value: String(current),
                validateInput: (v) => {
                    const n = parseInt(v);
                    return (isNaN(n) || n < 1 || n > 60)
                        ? vscode.l10n.t("Please enter a number between 1 and 60")
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
        vscode.commands.registerCommand("cursor-usage-monitor.showAllItems", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            await config.update("hiddenItems", [], vscode.ConfigurationTarget.Global);
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
                const choices = ["includedRequests", "onDemandUsage"]
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

    context.subscriptions.push(
        vscode.commands.registerCommand("cursor-usage-monitor.configureAlerts", async () => {
            const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
            const enabled = config.get<boolean>("alertEnabled", false);
            const currentItems = config.get<string[]>("alertItems", ["newSession"]);

            const toggleChoice = await vscode.window.showQuickPick(
                [
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

            if (toggleChoice.id === "toggle") {
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

                const input = await vscode.window.showInputBox({
                    prompt: `${item.label} ${vscode.l10n.t("threshold")} (${item.min}-${item.max})`,
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

    tracker.poll();
    startPolling();
    updateStatusBar();

    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cursorUsageMonitor")) {
            treeProvider.refresh();
            updateStatusBar();
            startPolling();
        }
    });
}

const extLog = vscode.window.createOutputChannel("Cursor Usage Monitor - Extension");

function startPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
    }

    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const pollingInterval = config.get<number>("pollingInterval", 3) * 1000;

    extLog.appendLine(`[${new Date().toISOString()}] 启动轮询定时器，间隔=${pollingInterval}ms`);

    pollTimer = setInterval(() => {
        tracker.poll().catch((err) => {
            extLog.appendLine(`[${new Date().toISOString()}] 轮询出错: ${err}`);
            console.error("[CursorUsageMonitor] Poll error:", err);
        });
    }, pollingInterval);
}

export function deactivate() {
    if (pollTimer) {
        clearInterval(pollTimer);
    }
    for (const item of statusBarItems.values()) {
        item.dispose();
    }
    statusBarItems.clear();
}
