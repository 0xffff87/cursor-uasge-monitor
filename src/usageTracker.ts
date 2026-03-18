import * as vscode from "vscode";
import { fetchUsage, UsageSnapshot } from "./api";

export interface AlertChange {
    type: "newSession" | "includedRequests" | "onDemandSpending" | "totalTokens";
    delta: number;
    threshold: number;
}

const log = vscode.window.createOutputChannel("Cursor Usage Monitor - Tracker");

export class UsageTracker {
    private _lastSnapshot: UsageSnapshot | null = null;
    private _onUpdate: (() => void) | null = null;
    private _onAlert: ((alerts: AlertChange[]) => void) | null = null;
    private _polling = false;
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

    async poll(force = false): Promise<boolean> {
        this._pollCount++;
        const pollId = this._pollCount;
        const ts = new Date().toISOString();

        if (this._polling) {
            log.appendLine(`[${ts}] poll#${pollId} SKIPPED (上一次轮询仍在进行中)`);
            return false;
        }
        this._polling = true;
        log.appendLine(`[${ts}] poll#${pollId} 开始 (force=${force})`);

        try {
            const startTime = Date.now();
            const snapshot = await fetchUsage();
            const elapsed = Date.now() - startTime;

            if (!snapshot) {
                log.appendLine(`[${ts}] poll#${pollId} fetchUsage 返回 null (耗时 ${elapsed}ms)`);
                if (force && this._onUpdate) {
                    this._onUpdate();
                }
                return false;
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
                this.checkAlerts(prev, snapshot);
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

    private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot): void {
        const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
        const enabled = config.get<boolean>("alertEnabled", false);
        if (!enabled) return;

        const items = config.get<string[]>("alertItems", ["newSession"]);
        const alerts: AlertChange[] = [];

        if (items.includes("newSession")) {
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

        if (items.includes("totalTokens")) {
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
