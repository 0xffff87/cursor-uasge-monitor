import * as https from "https";
import * as vscode from "vscode";
import { getUserId, getAccessToken, clearCachedToken } from "./credentials";

const outputChannel = vscode.window.createOutputChannel("Cursor Usage Monitor");

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
    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const manualToken = config.get<string>("sessionToken", "");

    if (manualToken) {
        const userId = manualToken.split("%3A%3A")[0];
        return { userId, cookieValue: manualToken };
    }

    const userId = await getUserId();
    if (!userId) { log("无法获取 userId"); return null; }

    const accessToken = await getAccessToken();
    if (!accessToken) { log("无法获取 accessToken"); return null; }

    return { userId, cookieValue: `${userId}%3A%3A${accessToken}` };
}

export async function fetchUsage(): Promise<UsageSnapshot | null> {
    const session = await getSessionToken();
    if (!session) return null;

    const usageData = await httpGet(`https://cursor.com/api/usage?user=${session.userId}`, session.cookieValue);
    if (!usageData) { log("获取 /api/usage 失败"); return null; }

    const gpt4 = usageData["gpt-4"];
    const maxRequests = gpt4?.maxRequestUsage ?? 500;
    const startOfMonth = usageData.startOfMonth || "";

    let onDemandSpentDollars = 0;
    let onDemandLimitDollars = 0;
    let includedUsed = Math.min(gpt4?.numRequests ?? 0, maxRequests);

    const teamData = await fetchTeamSpendData(session.cookieValue);
    if (teamData) {
        onDemandSpentDollars = teamData.spentDollars;
        onDemandLimitDollars = teamData.limitDollars;
        if (teamData.fastPremiumRequests !== undefined) {
            includedUsed = Math.min(teamData.fastPremiumRequests, maxRequests);
        }
    }

    const config = vscode.workspace.getConfiguration("cursorUsageMonitor");
    const displayCount = config.get<number>("displayCount", 5);
    const events = await fetchUsageEvents(session.cookieValue, displayCount);

    return {
        timestamp: new Date(),
        includedUsed,
        includedLimit: maxRequests,
        onDemandSpentDollars,
        onDemandLimitDollars,
        startOfMonth,
        events,
    };
}

async function fetchUsageEvents(cookieValue: string, count: number): Promise<UsageEvent[]> {
    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const data = await httpPost(
        "https://cursor.com/api/dashboard/get-filtered-usage-events",
        { startDate: thirtyDaysAgo, endDate: now, page: 1, pageSize: count },
        cookieValue,
    );

    if (!data || !data.usageEventsDisplay) {
        log("get-filtered-usage-events 无数据");
        return [];
    }

    log(`获取到 ${data.usageEventsDisplay.length} 条用量事件 (总计 ${data.totalUsageEventsCount})`);

    return data.usageEventsDisplay.map((e: any) => {
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

function makeRequest(method: string, url: string, body: any | null, cookieValue: string, retryOnAuth: boolean, redirectCount = 0): Promise<any | null> {
    return new Promise((resolve) => {
        if (redirectCount > 5) { resolve(null); return; }

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
                clearCachedToken();
                if (retryOnAuth) { retryRequest(method, url, body).then(resolve); }
                else { resolve(null); }
                return;
            }

            if (res.statusCode && res.statusCode >= 400) {
                let errData = "";
                res.on("data", (chunk) => { errData += chunk; });
                res.on("end", () => { resolve(null); });
                return;
            }

            if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (location) {
                    const redirectUrl = location.startsWith("http") ? location : `https://cursor.com${location}`;
                    makeRequest(method, redirectUrl, body, cookieValue, retryOnAuth, redirectCount + 1).then(resolve);
                } else { resolve(null); }
                return;
            }

            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
            });
        });

        req.on("error", () => resolve(null));
        req.setTimeout(30000, () => { req.destroy(); resolve(null); });
        if (postData) { req.write(postData); }
        req.end();
    });
}

async function retryRequest(method: string, url: string, body: any | null): Promise<any | null> {
    const session = await getSessionToken();
    if (!session) return null;
    return makeRequest(method, url, body, session.cookieValue, false);
}
