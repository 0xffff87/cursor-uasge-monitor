import * as vscode from "vscode";
import { fetchUsage, UsageSnapshot, FetchResult, getMaxModeInfo, MaxModeInfo } from "./api";

export interface AlertChange {
    type: "newSession" | "includedRequests" | "onDemandSpending" | "totalTokens";
    delta: number;
    threshold: number;
}

const log = vscode.window.createOutputChannel("Cursor Usage Monitor - Tracker");

export class UsageTracker {
    private _lastSnapshot: UsageSnapshot | null = null;
    private _lastError: string | null = null;
    private _eventsError = false;
    private _consecutiveFailures = 0;
    private _lastSuccessTime: Date | null = null;
    private _onUpdate: (() => void) | null = null;
    private _onAlert: ((alerts: AlertChange[]) => void) | null = null;
    private _polling = false;
    private _pollStartTime = 0;
    private _pollCount = 0;
    private _activePollId = 0;
    private _maxModeInfo: MaxModeInfo | null = null;

    set onUpdate(callback: (() => void) | null) {
        this._onUpdate = callback;
    }

    set onAlert(callback: ((alerts: AlertChange[]) => void) | null) {
        this._onAlert = callback;
    }

    get lastSnapshot(): UsageSnapshot | null {
        return this._lastSnapshot;
    }

    get lastError(): string | null {
        return this._lastError;
    }

    get eventsError(): boolean {
        return this._eventsError;
    }

    get consecutiveFailures(): number {
        return this._consecutiveFailures;
    }

    get lastSuccessTime(): Date | null {
        return this._lastSuccessTime;
    }

    get maxModeInfo(): MaxModeInfo | null {
        return this._maxModeInfo;
    }

    set maxModeInfo(info: MaxModeInfo | null) {
        this._maxModeInfo = info;
    }

    async poll(force = false): Promise<boolean> {
        this._pollCount++;
        const pollId = this._pollCount;
        const ts = new Date().toISOString();

        if (this._polling) {
            const elapsed = Date.now() - this._pollStartTime;
            if (elapsed > 120000) {
                log.appendLine(`[${ts}] poll#${pollId} 上次轮询已运行 ${Math.round(elapsed / 1000)}s，强制重置 _polling`);
                this._polling = false;
            } else {
                log.appendLine(`[${ts}] poll#${pollId} SKIPPED (上一次轮询仍在进行中, 已运行 ${Math.round(elapsed / 1000)}s)`);
                return false;
            }
        }
        this._activePollId = pollId;
        this._polling = true;
        this._pollStartTime = Date.now();
        log.appendLine(`[${ts}] poll#${pollId} 开始 (force=${force}, activePollId=${this._activePollId})`);

        try {
            // 读取本地 Max Mode 状态（仅用于 UI 显示）
            try {
                this._maxModeInfo = await getMaxModeInfo();
            } catch {
                log.appendLine(`[${ts}] poll#${pollId} 读取 Max Mode 信息失败`);
            }

            const startTime = Date.now();
            const POLL_TIMEOUT = 90000;
            const result = await Promise.race([
                fetchUsage(),
                new Promise<FetchResult>((resolve) =>
                    setTimeout(() => resolve({ snapshot: null, error: "数据获取超时", eventsError: false, teamDataError: false }), POLL_TIMEOUT)
                ),
            ]);
            const elapsed = Date.now() - startTime;
            const snapshot = result.snapshot;

            // 完全失败：snapshot 为 null
            if (!snapshot) {
                this._lastError = result.error;
                this._consecutiveFailures++;
                log.appendLine(`[${ts}] poll#${pollId} 完全失败: ${result.error} (耗时 ${elapsed}ms, 连续失败 ${this._consecutiveFailures} 次)`);
                if (this._onUpdate) {
                    this._onUpdate();
                }
                return false;
            }

            // 部分失败：团队数据或事件数据获取失败
            const isPartialFailure = result.teamDataError || result.eventsError;

            if (isPartialFailure) {
                this._consecutiveFailures++;
                this._eventsError = result.eventsError;

                const reasons: string[] = [];
                if (result.teamDataError) reasons.push("团队数据");
                if (result.eventsError) reasons.push("事件数据");
                log.appendLine(`[${ts}] poll#${pollId} 部分失败: ${reasons.join("+")}获取失败 (耗时 ${elapsed}ms, 连续失败 ${this._consecutiveFailures} 次)`);
                log.appendLine(`  不更新本地数据，保留上次成功的快照`);

                // 部分失败时不更新 _lastSnapshot，保留上次完全成功的数据
                // 但仍然触发 UI 刷新以显示错误状态
                if (this._onUpdate) {
                    this._onUpdate();
                }
                return false;
            }

            // 完全成功：所有数据获取成功
            const wasRecovering = this._consecutiveFailures > 0;
            this._lastError = null;
            this._consecutiveFailures = 0;
            this._lastSuccessTime = new Date();
            this._eventsError = false;

            log.appendLine(`[${ts}] poll#${pollId} 完全成功 (耗时 ${elapsed}ms${wasRecovering ? ", 从失败中恢复" : ""})`);
            log.appendLine(`  当前数据: events=${snapshot.events.length}, included=${snapshot.includedUsed}/${snapshot.includedLimit}(${snapshot.includedSource}), onDemand=$${snapshot.onDemandSpentDollars.toFixed(2)}`);
            if (snapshot.events.length > 0) {
                const e = snapshot.events[0];
                log.appendLine(`  最新事件: ts=${new Date(e.timestamp).toISOString()}, model=${e.model}, tokens=${e.totalTokens}, reqs=${e.requests}, cents=${e.chargedCents}`);
            }

            const prev = this._lastSnapshot;
            if (prev) {
                log.appendLine(`  上次数据: events=${prev.events.length}, included=${prev.includedUsed}/${prev.includedLimit}(${prev.includedSource}), onDemand=$${prev.onDemandSpentDollars.toFixed(2)}`);
                if (prev.events.length > 0) {
                    const pe = prev.events[0];
                    log.appendLine(`  上次最新: ts=${new Date(pe.timestamp).toISOString()}, model=${pe.model}, tokens=${pe.totalTokens}, reqs=${pe.requests}, cents=${pe.chargedCents}`);
                }
            } else {
                log.appendLine(`  上次数据: null (首次轮询)`);
            }

            let changed = !prev
                || snapshot.events.length !== prev.events.length
                || snapshot.includedUsed !== prev.includedUsed
                || snapshot.onDemandSpentDollars !== prev.onDemandSpentDollars;

            if (!changed && prev) {
                for (let i = 0; i < snapshot.events.length; i++) {
                    const ce = snapshot.events[i];
                    const pe = prev.events[i];
                    if (!pe
                        || ce.timestamp !== pe.timestamp
                        || ce.totalTokens !== pe.totalTokens
                        || ce.requests !== pe.requests
                        || ce.chargedCents !== pe.chargedCents
                        || ce.maxMode !== pe.maxMode) {
                        changed = true;
                        log.appendLine(`  事件[${i}]变化: tokens(${pe?.totalTokens}→${ce.totalTokens}), reqs(${pe?.requests}→${ce.requests}), cents(${pe?.chargedCents}→${ce.chargedCents})`);
                        break;
                    }
                }
            }

            log.appendLine(`  变化检测: changed=${changed}, force=${force}`);

            if (pollId !== this._activePollId) {
                log.appendLine(`[${ts}] poll#${pollId} 已过期（当前活跃=${this._activePollId}），丢弃结果`);
                return false;
            }

            log.appendLine(`  保存 snapshot (pollId=${pollId}, activePollId=${this._activePollId})`);
            this._lastSnapshot = snapshot;

            // 只在完全成功且非恢复期时检查 alert
            if (prev && changed) {
                if (wasRecovering) {
                    log.appendLine(`  从失败中恢复，跳过 alert 检测（避免掉线恢复误报）`);
                } else {
                    this.checkAlerts(prev, snapshot);
                }
            }

            if ((changed || force) && this._onUpdate) {
                log.appendLine(`  触发 UI 刷新`);
                this._onUpdate();
            } else if (!changed && !force) {
                log.appendLine(`  数据无变化且非强制刷新，跳过 UI 刷新`);
            }

            return changed;
        } catch (err) {
            log.appendLine(`[${ts}] poll#${pollId} 异常: ${err}`);
            console.error("[CursorUsageMonitor] Poll error:", err);
            if (force && this._onUpdate) {
                this._onUpdate();
            }
            return false;
        } finally {
            this._polling = false;
            log.appendLine(`[${new Date().toISOString()}] poll#${pollId} 结束`);
        }
    }

    private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot): void {
        const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
        const enabled = config.get<boolean>("alertEnabled", true);
        if (!enabled) return;

        const items = config.get<string[]>("alertItems", ["newSession", "includedRequests", "onDemandSpending"]);
        const alerts: AlertChange[] = [];

        if (items.includes("newSession")) {
            const prevTimestamps = new Set(prev.events.map(e => e.timestamp));
            const newCount = curr.events.filter(e => !prevTimestamps.has(e.timestamp)).length;
            const threshold = config.get<number>("alertThreshold.newSession", 0);
            if (newCount > 0 && newCount >= threshold) {
                alerts.push({ type: "newSession", delta: newCount, threshold });
            }
        }

        // 数据源发生切换（fastPremium ↔ numRequests）时跳过 included alert
        if (items.includes("includedRequests")) {
            if (prev.includedSource !== curr.includedSource) {
                log.appendLine(`  includedSource 切换 (${prev.includedSource} → ${curr.includedSource})，跳过 includedRequests alert`);
            } else {
                const delta = curr.includedUsed - prev.includedUsed;
                const threshold = config.get<number>("alertThreshold.includedRequests", 0);
                if (delta > 0 && delta >= threshold) {
                    alerts.push({ type: "includedRequests", delta, threshold });
                }
            }
        }

        if (items.includes("onDemandSpending")) {
            const delta = curr.onDemandSpentDollars - prev.onDemandSpentDollars;
            const threshold = config.get<number>("alertThreshold.onDemandSpending", 0);
            if (delta > 0 && delta >= threshold) {
                alerts.push({ type: "onDemandSpending", delta, threshold });
            }
        }

        if (items.includes("totalTokens")) {
            const prevMap = new Map(prev.events.map(e => [e.timestamp, e.totalTokens]));
            let prevTokens = 0;
            let currTokens = 0;
            for (const e of curr.events) {
                const prevToken = prevMap.get(e.timestamp);
                if (prevToken !== undefined) {
                    prevTokens += prevToken;
                    currTokens += e.totalTokens;
                }
            }
            const delta = currTokens - prevTokens;
            const threshold = config.get<number>("alertThreshold.totalTokens", 100000);
            if (delta > 0 && delta >= threshold) {
                alerts.push({ type: "totalTokens", delta, threshold });
            }
        }

        if (alerts.length > 0 && this._onAlert) {
            this._onAlert(alerts);
        }
    }
}
