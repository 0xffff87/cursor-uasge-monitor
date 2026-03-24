import * as vscode from "vscode";
import { fetchUsage, UsageSnapshot, FetchResult } from "./api";

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

    async poll(force = false): Promise<boolean> {
        this._pollCount++;
        const pollId = this._pollCount;
        const ts = new Date().toISOString();

        if (this._polling) {
            const elapsed = Date.now() - this._pollStartTime;
            // 防止轮询卡死：超过 120 秒强制重置
            if (elapsed > 120000) {
                log.appendLine(`[${ts}] poll#${pollId} 上次轮询已运行 ${Math.round(elapsed / 1000)}s，强制重置 _polling`);
                this._polling = false;
            } else {
                log.appendLine(`[${ts}] poll#${pollId} SKIPPED (上一次轮询仍在进行中, 已运行 ${Math.round(elapsed / 1000)}s)`);
                return false;
            }
        }
        this._polling = true;
        this._pollStartTime = Date.now();
        log.appendLine(`[${ts}] poll#${pollId} 开始 (force=${force})`);

        try {
            const startTime = Date.now();
            const POLL_TIMEOUT = 90000;
            const result = await Promise.race([
                fetchUsage(),
                new Promise<FetchResult>((resolve) =>
                    setTimeout(() => resolve({ snapshot: null, error: "数据获取超时", eventsError: false }), POLL_TIMEOUT)
                ),
            ]);
            const elapsed = Date.now() - startTime;
            const snapshot = result.snapshot;

            if (!snapshot) {
                this._lastError = result.error;
                this._consecutiveFailures++;
                log.appendLine(`[${ts}] poll#${pollId} fetchUsage 失败: ${result.error} (耗时 ${elapsed}ms, 连续失败 ${this._consecutiveFailures} 次)`);
                if (this._onUpdate) {
                    this._onUpdate();
                }
                return false;
            }

            this._lastError = null;
            this._consecutiveFailures = 0;
            this._lastSuccessTime = new Date();
            const prevEventsError = this._eventsError;
            this._eventsError = result.eventsError;

            // 事件 API 失败时，保留上次成功获取的事件数据
            if (result.eventsError && snapshot.events.length === 0 && this._lastSnapshot && this._lastSnapshot.events.length > 0) {
                log.appendLine(`[${ts}] poll#${pollId} 事件 API 失败，保留上次 ${this._lastSnapshot.events.length} 条事件数据`);
                snapshot.events = this._lastSnapshot.events;
            }

            log.appendLine(`[${ts}] poll#${pollId} fetchUsage 成功 (耗时 ${elapsed}ms)`);
            log.appendLine(`  当前数据: events=${snapshot.events.length}, included=${snapshot.includedUsed}/${snapshot.includedLimit}, onDemand=$${snapshot.onDemandSpentDollars.toFixed(2)}`);
            if (snapshot.events.length > 0) {
                const e = snapshot.events[0];
                log.appendLine(`  最新事件: ts=${new Date(e.timestamp).toISOString()}, model=${e.model}, tokens=${e.totalTokens}, reqs=${e.requests}, cents=${e.chargedCents}`);
            }

            const prev = this._lastSnapshot;
            if (prev) {
                log.appendLine(`  上次数据: events=${prev.events.length}, included=${prev.includedUsed}/${prev.includedLimit}, onDemand=$${prev.onDemandSpentDollars.toFixed(2)}`);
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
                        || ce.chargedCents !== pe.chargedCents) {
                        changed = true;
                        log.appendLine(`  事件[${i}]变化: tokens(${pe?.totalTokens}→${ce.totalTokens}), reqs(${pe?.requests}→${ce.requests}), cents(${pe?.chargedCents}→${ce.chargedCents})`);
                        break;
                    }
                }
            }

            log.appendLine(`  变化检测: changed=${changed}, force=${force}`);
            if (prev && !changed) {
                log.appendLine(`  无变化: evtLen=${snapshot.events.length}, incl=${snapshot.includedUsed}, od=$${snapshot.onDemandSpentDollars}`);
            }

            if (prev && changed) {
                this.checkAlerts(prev, snapshot, prevEventsError);
            }

            this._lastSnapshot = snapshot;

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

    private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot, prevEventsError: boolean): void {
        const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
        const enabled = config.get<boolean>("alertEnabled", false);
        if (!enabled) return;

        const items = config.get<string[]>("alertItems", ["newSession"]);
        const alerts: AlertChange[] = [];

        // 上次事件数据不可靠（API 失败/缓存）时，跳过事件相关的提醒，避免误报
        if (items.includes("newSession") && !prevEventsError) {
            // 通过比较 timestamp 识别新事件，而非数组长度（因为 API 返回数量受 displayCount 限制，长度可能不变）
            const prevTimestamps = new Set(prev.events.map(e => e.timestamp));
            const newCount = curr.events.filter(e => !prevTimestamps.has(e.timestamp)).length;
            const threshold = config.get<number>("alertThreshold.newSession", 1);
            if (newCount > 0 && newCount >= threshold) {
                alerts.push({ type: "newSession", delta: newCount, threshold });
            }
        }

        if (items.includes("includedRequests")) {
            const delta = curr.includedUsed - prev.includedUsed;
            const threshold = config.get<number>("alertThreshold.includedRequests", 10);
            if (delta > 0 && delta >= threshold) {
                alerts.push({ type: "includedRequests", delta, threshold });
            }
        }

        if (items.includes("onDemandSpending")) {
            const delta = curr.onDemandSpentDollars - prev.onDemandSpentDollars;
            const threshold = config.get<number>("alertThreshold.onDemandSpending", 1.0);
            if (delta > 0 && delta >= threshold) {
                alerts.push({ type: "onDemandSpending", delta, threshold });
            }
        }

        if (items.includes("totalTokens") && !prevEventsError) {
            // 只比较两次快照中都存在的事件（通过 timestamp 匹配），排除新增事件对 token 总量的影响
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
