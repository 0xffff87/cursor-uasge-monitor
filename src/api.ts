import * as https from "https";
import * as vscode from "vscode";
import { getUserId, getAccessToken, clearCachedToken } from "./credentials";

const outputChannel = vscode.window.createOutputChannel("Cursor Usage Monitor");

const SECRET_KEY = "cursorUsageMonitor.sessionToken";
let secretStorage: vscode.SecretStorage | null = null;

export function initSecretStorage(storage: vscode.SecretStorage): void {
    secretStorage = storage;
}

export async function getSecretToken(): Promise<string | undefined> {
    if (!secretStorage) return undefined;
    return secretStorage.get(SECRET_KEY);
}

export async function storeSecretToken(token: string): Promise<void> {
    if (!secretStorage) return;
    await secretStorage.store(SECRET_KEY, token);
}

export async function deleteSecretToken(): Promise<void> {
    if (!secretStorage) return;
    await secretStorage.delete(SECRET_KEY);
}

export interface UsageEvent {
    timestamp: number;
    model: string;
    kind: string;
    requests: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    chargedCents: number;
    usageBasedCosts: string;
}

export interface UsageSnapshot {
    timestamp: Date;
    includedUsed: number;
    includedLimit: number;
    onDemandSpentDollars: number;
    onDemandLimitDollars: number;
    startOfMonth: string;
    events: UsageEvent[];
}

function log(msg: string) {
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function getSessionToken(): Promise<{ userId: string; cookieValue: string } | null> {
    // 优先从本地 Cursor 数据库自动获取
    const userId = await getUserId();
    const accessToken = userId ? await getAccessToken() : null;

    if (userId && accessToken) {
        return { userId, cookieValue: `${userId}%3A%3A${accessToken}` };
    }

    // 自动获取失败时，回退到用户手动设置的 token（SecretStorage 加密存储）
    const manualToken = await getSecretToken();
    if (manualToken) {
        log("自动获取失败，使用手动设置的 token");
        const manualUserId = manualToken.split("%3A%3A")[0];
        return { userId: manualUserId, cookieValue: manualToken };
    }

    log("无法获取 Session Token（自动和手动均失败）");
    return null;
}

export interface FetchResult {
    snapshot: UsageSnapshot | null;
    error: string | null;
    eventsError: boolean;
}

export async function fetchUsage(): Promise<FetchResult> {
    const session = await getSessionToken();
    if (!session) return { snapshot: null, error: "无法获取 Session Token", eventsError: false };

    const usageData = await httpGet(`https://cursor.com/api/usage?user=${session.userId}`, session.cookieValue);
    if (!usageData) { log("获取 /api/usage 失败"); return { snapshot: null, error: "获取 /api/usage 失败", eventsError: false }; }

    const gpt4 = usageData["gpt-4"];
    const maxRequests = gpt4?.maxRequestUsage ?? 500;
    const startOfMonth = usageData.startOfMonth || "";

    let onDemandSpentDollars = 0;
    let onDemandLimitDollars = 0;
    const numRequestsFromUsage = gpt4?.numRequests ?? 0;
    // numRequests 包含所有类型请求，仅在无团队数据时使用
    let includedUsed = numRequestsFromUsage;

    const teamData = await fetchTeamSpendData(session.cookieValue);
    if (teamData) {
        onDemandSpentDollars = teamData.spentDollars;
        onDemandLimitDollars = teamData.limitDollars;
        // 优先使用 fastPremiumRequests（仅计算 premium 请求，与官网一致）
        if (typeof teamData.fastPremiumRequests === "number") {
            log(`Included Requests 数据源: 使用 team/fastPremium=${teamData.fastPremiumRequests} (numRequests=${numRequestsFromUsage} 包含非 premium 请求)`);
            includedUsed = teamData.fastPremiumRequests;
        } else {
            log(`Included Requests 数据源: fastPremiumRequests 不可用，回退到 numRequests=${numRequestsFromUsage}`);
        }
    } else {
        log(`Included Requests 数据源: 团队数据获取失败，使用 numRequests=${numRequestsFromUsage}`);
    }

    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const displayCount = config.get<number>("displayCount", 5);
    const eventsResult = await fetchUsageEvents(session.cookieValue, displayCount);

    return {
        snapshot: {
            timestamp: new Date(),
            includedUsed,
            includedLimit: maxRequests,
            onDemandSpentDollars,
            onDemandLimitDollars,
            startOfMonth,
            events: eventsResult.events,
        },
        error: null,
        eventsError: eventsResult.error,
    };
}

async function fetchUsageEvents(cookieValue: string, count: number): Promise<{ events: UsageEvent[]; error: boolean }> {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const data = await httpPost(
        "https://cursor.com/api/dashboard/get-filtered-usage-events",
        { startDate: thirtyDaysAgo, endDate: now, page: 1, pageSize: count },
        cookieValue,
    );

    if (!data || !data.usageEventsDisplay) {
        log("get-filtered-usage-events 无数据");
        return { events: [], error: true };
    }

    log(`获取到 ${data.usageEventsDisplay.length} 条用量事件 (总计 ${data.totalUsageEventsCount})`);

    const events = data.usageEventsDisplay.map((e: any) => {
        const tok = e.tokenUsage || {};
        const totalTokens = (tok.inputTokens || 0) + (tok.outputTokens || 0)
            + (tok.cacheWriteTokens || 0) + (tok.cacheReadTokens || 0);
        return {
            timestamp: parseInt(e.timestamp) || 0,
            model: e.model || "unknown",
            kind: e.kind || "",
            requests: e.requestsCosts || 0,
            totalTokens,
            inputTokens: tok.inputTokens || 0,
            outputTokens: tok.outputTokens || 0,
            chargedCents: e.chargedCents || 0,
            usageBasedCosts: e.usageBasedCosts || "",
        };
    });
    return { events, error: false };
}

interface TeamSpendResult {
    spentDollars: number;
    limitDollars: number;
    fastPremiumRequests?: number;
}

async function fetchTeamSpendData(cookieValue: string): Promise<TeamSpendResult | null> {
    const teamsData = await httpPost("https://cursor.com/api/dashboard/teams", {}, cookieValue);
    if (!teamsData || !teamsData.teams || teamsData.teams.length === 0) return null;

    const teamId = teamsData.teams[0].id;

    const meData = await httpGet("https://cursor.com/api/auth/me", cookieValue);
    if (!meData || !meData.id) return null;

    const spendData = await httpPost("https://cursor.com/api/dashboard/get-team-spend", { teamId }, cookieValue);
    if (!spendData || !spendData.teamMemberSpend) return null;

    const mySpend = spendData.teamMemberSpend.find((m: any) => m.userId === meData.id);
    if (!mySpend) return null;

    return {
        spentDollars: (mySpend.spendCents || 0) / 100,
        limitDollars: mySpend.hardLimitOverrideDollars || mySpend.effectivePerUserLimitDollars || 0,
        fastPremiumRequests: mySpend.fastPremiumRequests,
    };
}

function httpGet(url: string, cookieValue: string, retryOnAuth = true): Promise<any | null> {
    return makeRequest("GET", url, null, cookieValue, retryOnAuth);
}

function httpPost(url: string, body: any, cookieValue: string, retryOnAuth = true): Promise<any | null> {
    return makeRequest("POST", url, body, cookieValue, retryOnAuth);
}

function makeRequest(method: string, url: string, body: any | null, cookieValue: string, retryOnAuth: boolean, redirectCount = 0, serverRetryCount = 0): Promise<any | null> {
    return new Promise((resolve) => {
        if (redirectCount > 5) {
            log(`${method} ${url} 重定向次数超过上限`);
            resolve(null);
            return;
        }

        const urlObj = new URL(url);
        const postData = body ? JSON.stringify(body) : null;

        const options: https.RequestOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Content-Type": "application/json",
                "Cookie": `WorkosCursorSessionToken=${cookieValue}`,
                "Origin": "https://cursor.com",
                "Referer": "https://cursor.com/cn/dashboard/usage",
                ...(postData ? { "Content-Length": Buffer.byteLength(postData).toString() } : {}),
            },
        };

        const req = https.request(options, (res) => {
            req.removeAllListeners("timeout");
            if (res.statusCode === 401) {
                log(`${method} ${url} → 401 认证失败，清除缓存 token 并重试`);
                clearCachedToken();
                if (retryOnAuth) { retryRequest(method, url, body).then(resolve); }
                else { log(`${method} ${url} → 401 重试后仍失败`); resolve(null); }
                return;
            }

            if (res.statusCode && res.statusCode >= 400) {
                let errData = "";
                res.on("data", (chunk) => { errData += chunk; });
                res.on("end", () => {
                    log(`${method} ${url} → HTTP ${res.statusCode}: ${errData.substring(0, 500)}`);
                    // 5xx 服务器错误自动重试（最多 2 次，间隔 3 秒）
                    if (res.statusCode! >= 500 && serverRetryCount < 2) {
                        const delay = (serverRetryCount + 1) * 3000;
                        log(`${method} ${url} → 服务器错误，${delay / 1000}s 后第 ${serverRetryCount + 1} 次重试`);
                        setTimeout(() => {
                            makeRequest(method, url, body, cookieValue, retryOnAuth, 0, serverRetryCount + 1).then(resolve);
                        }, delay);
                    } else {
                        resolve(null);
                    }
                });
                return;
            }

            if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                log(`${method} ${url} → ${res.statusCode} 重定向到 ${location || "(无 location)"}`);
                if (location) {
                    const redirectUrl = location.startsWith("http") ? location : `https://cursor.com${location}`;
                    makeRequest(method, redirectUrl, body, cookieValue, retryOnAuth, redirectCount + 1, serverRetryCount).then(resolve);
                } else { resolve(null); }
                return;
            }

            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                try { resolve(JSON.parse(data)); }
                catch {
                    log(`${method} ${url} → HTTP ${res.statusCode} JSON 解析失败: ${data.substring(0, 200)}`);
                    resolve(null);
                }
            });
        });

        req.on("error", (err) => {
            log(`${method} ${url} → 网络错误: ${err.message}`);
            resolve(null);
        });
        req.setTimeout(30000, () => {
            log(`${method} ${url} → 请求超时 (30s)`);
            req.destroy();
            resolve(null);
        });
        if (postData) { req.write(postData); }
        req.end();
    });
}

async function retryRequest(method: string, url: string, body: any | null): Promise<any | null> {
    const session = await getSessionToken();
    if (!session) return null;
    return makeRequest(method, url, body, session.cookieValue, false);
}
