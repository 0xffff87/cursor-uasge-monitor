import * as vscode from "vscode";
import { UsageEvent } from "./api";
import { UsageTracker } from "./usageTracker";

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<UsageTreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private tracker: UsageTracker) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: UsageTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: UsageTreeItem): UsageTreeItem[] {
        if (element) {
            return element.children || [];
        }

        const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
        const displayCount = config.get<number>("displayCount", 5);
        const snapshot = this.tracker.lastSnapshot;

        const items: UsageTreeItem[] = [];

        const hiddenItems = config.get<string[]>("hiddenItems", []);

        if (snapshot && !hiddenItems.includes("summarySection")) {
            let summaryLabel: string;
            if (snapshot.startOfMonth) {
                const resetDate = new Date(snapshot.startOfMonth);
                const nextReset = new Date(resetDate);
                nextReset.setMonth(nextReset.getMonth() + 1);
                const daysLeft = Math.ceil((nextReset.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                summaryLabel = `📊 ${vscode.l10n.t("Monthly Summary (Reset in: {0} days)", daysLeft)}`;
            } else {
                summaryLabel = `📊 ${vscode.l10n.t("Monthly Summary")}`;
            }
            const summaryItem = new UsageTreeItem(
                summaryLabel,
                vscode.TreeItemCollapsibleState.Expanded,
            );
            summaryItem.contextValue = "summarySection";
            const children: UsageTreeItem[] = [];

            if (!hiddenItems.includes("includedRequests")) {
                const includedItem = new UsageTreeItem(
                    "Included Requests",
                    vscode.TreeItemCollapsibleState.None,
                );
                includedItem.description = `${snapshot.includedUsed}/${snapshot.includedLimit}`;
                includedItem.iconPath = getUsageIcon(snapshot.includedUsed, snapshot.includedLimit);
                includedItem.contextValue = "summaryChild_includedRequests";
                children.push(includedItem);
            }

            if (!hiddenItems.includes("onDemandUsage")) {
                const onDemandItem = new UsageTreeItem(
                    "On-Demand Usage",
                    vscode.TreeItemCollapsibleState.None,
                );
                const spentStr = `$${snapshot.onDemandSpentDollars.toFixed(2)}`;
                if (snapshot.onDemandLimitDollars > 0) {
                    onDemandItem.description = `${spentStr}/$${snapshot.onDemandLimitDollars}`;
                    onDemandItem.iconPath = getDollarIcon(snapshot.onDemandSpentDollars / snapshot.onDemandLimitDollars);
                } else {
                    onDemandItem.description = spentStr;
                    onDemandItem.iconPath = new vscode.ThemeIcon("dash");
                }
                onDemandItem.contextValue = "summaryChild_onDemandUsage";
                children.push(onDemandItem);
            }

            summaryItem.children = children;
            items.push(summaryItem);
        }

        if (snapshot && snapshot.events.length > 0 && !hiddenItems.includes("recentSection")) {
            const hiddenTimestamps = new Set(config.get<number[]>("hiddenEventTimestamps", []));
            const visibleEvents = snapshot.events
                .slice(0, displayCount)
                .filter((e) => !hiddenTimestamps.has(e.timestamp));
            const count = visibleEvents.length;
            const recentItem = new UsageTreeItem(
                `📋 ${vscode.l10n.t("Recent Usage ({0} entries)", count)}`,
                vscode.TreeItemCollapsibleState.Expanded,
            );
            recentItem.contextValue = "recentSection";
            // 事件 API 失败时在标题上添加提示（使用缓存数据）
            if (this.tracker.eventsError) {
                recentItem.description = vscode.l10n.t("(cached)");
                recentItem.tooltip = vscode.l10n.t("Events API failed, showing cached data");
            }

            recentItem.children = visibleEvents.map((e) => {
                const timeStr = formatEventTime(e.timestamp);
                const typeLabel = e.kind.includes("USAGE_BASED") ? "On-Demand" : "Included";
                const modelStr = shortenModel(e.model);

                const entry = new UsageTreeItem(
                    `${timeStr}  ${modelStr}`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                );
                entry.id = `event_${e.timestamp}`;
                entry.description = `${typeLabel}`;
                entry.iconPath = e.kind.includes("USAGE_BASED")
                    ? new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.orange"))
                    : new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"));
                entry.tooltip = vscode.l10n.t("Click to expand details");
                entry.contextValue = "recentEvent";

                const detailChildren: UsageTreeItem[] = [];
                const showTokenDetail = config.get<boolean>("showTokenDetail", false);

                const tokensItem = new UsageTreeItem(
                    `Tokens: ${formatTokens(e.totalTokens)}`,
                    showTokenDetail ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
                );
                tokensItem.iconPath = new vscode.ThemeIcon("symbol-number");
                tokensItem.contextValue = "tokensItem";
                if (showTokenDetail) {
                    const inputItem = new UsageTreeItem(
                        vscode.l10n.t("Input: {0}", formatTokens(e.inputTokens)),
                        vscode.TreeItemCollapsibleState.None,
                    );
                    inputItem.iconPath = new vscode.ThemeIcon("arrow-up");
                    const outputItem = new UsageTreeItem(
                        vscode.l10n.t("Output: {0}", formatTokens(e.outputTokens)),
                        vscode.TreeItemCollapsibleState.None,
                    );
                    outputItem.iconPath = new vscode.ThemeIcon("arrow-down");
                    tokensItem.children = [inputItem, outputItem];
                }
                detailChildren.push(tokensItem);

                const reqItem = new UsageTreeItem(
                    `Requests: ${e.requests}`,
                    vscode.TreeItemCollapsibleState.None,
                );
                reqItem.iconPath = new vscode.ThemeIcon("arrow-swap");
                detailChildren.push(reqItem);

                const costStr = e.usageBasedCosts || `$${(e.chargedCents / 100).toFixed(2)}`;
                const costItem = new UsageTreeItem(
                    vscode.l10n.t("Cost: {0}", costStr),
                    vscode.TreeItemCollapsibleState.None,
                );
                costItem.iconPath = new vscode.ThemeIcon("credit-card");
                detailChildren.push(costItem);

                entry.children = detailChildren;
                return entry;
            });

            items.push(recentItem);
        } else if (snapshot && !hiddenItems.includes("recentSection")) {
            const noEventsItem = new UsageTreeItem(
                `📋 ${vscode.l10n.t("Recent Usage")}`,
                vscode.TreeItemCollapsibleState.None,
            );
            if (this.tracker.eventsError) {
                noEventsItem.description = vscode.l10n.t("Failed to fetch");
                noEventsItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
                noEventsItem.tooltip = vscode.l10n.t("Events API is unavailable, click refresh to retry");
            } else {
                noEventsItem.description = vscode.l10n.t("No data");
            }
            items.push(noEventsItem);
        }

        // 有缓存数据时也显示错误横幅（API 获取失败，正在使用缓存）
        const error = this.tracker.lastError;
        if (error && items.length > 0) {
            const failures = this.tracker.consecutiveFailures;
            const lastSuccess = this.tracker.lastSuccessTime;
            let errorText = error;
            if (failures > 1) {
                errorText = vscode.l10n.t("API unavailable (failed {0} times)", failures);
            }
            const errorItem = new UsageTreeItem(
                errorText,
                vscode.TreeItemCollapsibleState.None,
            );
            errorItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"));
            let tooltipLines = [vscode.l10n.t("Click refresh to retry")];
            if (lastSuccess) {
                tooltipLines.push(vscode.l10n.t("Last success: {0}", formatTime(lastSuccess)));
            }
            tooltipLines.push(vscode.l10n.t("Troubleshooting: Check network or try setting token manually"));
            errorItem.tooltip = tooltipLines.join("\n");
            items.unshift(errorItem);
        } else if (items.length === 0) {
            if (error) {
                const errorItem = new UsageTreeItem(
                    error,
                    vscode.TreeItemCollapsibleState.None,
                );
                errorItem.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.red"));
                const tooltipLines = [
                    vscode.l10n.t("Click refresh to retry"),
                    vscode.l10n.t("Troubleshooting: Check network or try setting token manually"),
                ];
                errorItem.tooltip = tooltipLines.join("\n");
                items.push(errorItem);
            } else {
                const loadingItem = new UsageTreeItem(
                    vscode.l10n.t("Loading..."),
                    vscode.TreeItemCollapsibleState.None,
                );
                loadingItem.iconPath = new vscode.ThemeIcon("sync~spin");
                items.push(loadingItem);
            }
        }

        return items;
    }
}

class UsageTreeItem extends vscode.TreeItem {
    children?: UsageTreeItem[];

    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
        super(label, collapsibleState);
    }
}

function formatEventTime(ts: number): string {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${h}:${m}`;
}

function formatTokens(tokens: number): string {
    if (tokens >= 10_000) return `${(tokens / 10_000).toFixed(1)}万`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return `${tokens}`;
}

function shortenModel(model: string): string {
    const map: Record<string, string> = {
        "claude-4.6-opus-high-thinking": "Claude 4.6 Opus",
        "claude-4.6-opus-high-thinking-fast": "Claude 4.6 Fast",
        "claude-4-sonnet-thinking": "Claude 4 Sonnet",
        "claude-4-sonnet": "Claude 4 Sonnet",
        "claude-3.5-sonnet": "Claude 3.5",
        "gpt-4o": "GPT-4o",
        "gpt-4o-mini": "GPT-4o Mini",
        "composer-1.5": "Composer 1.5",
        "cursor-small": "Cursor Small",
    };
    return map[model] || model;
}

function getUsageIcon(used: number, max: number): vscode.ThemeIcon {
    if (max <= 0) return new vscode.ThemeIcon("dash");
    const pct = used / max;
    if (pct < 0.4) return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
    if (pct < 0.7) return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"));
    return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
}

function getDollarIcon(pct: number): vscode.ThemeIcon {
    if (pct < 0.3) return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
    if (pct < 0.6) return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.yellow"));
    return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
}

function formatTime(date: Date): string {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
}
