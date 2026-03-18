import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";

const MAX_READFILE_SIZE = 2 * 1024 * 1024 * 1024;
const log = vscode.window.createOutputChannel("Cursor Usage Monitor - Credentials");

let cachedAccessToken: string | null = null;
let cachedUserId: string | null = null;

export function clearCachedToken(): void {
    cachedAccessToken = null;
}

export async function getUserId(): Promise<string | null> {
    if (cachedUserId) return cachedUserId;

    const paths = getStoragePaths();
    for (const p of paths) {
        try {
            const userId = await findUserIdInFile(p);
            if (userId) {
                log.appendLine(`从 ${p} 获取到 userId: ${userId.substring(0, 10)}...`);
                cachedUserId = userId;
                return userId;
            }
        } catch (err) {
            log.appendLine(`读取 ${p} 失败: ${err}`);
        }
    }

    // 回退：从数据库中读取 userId
    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
        const userId = await queryDb(dbPath, "cursorAuth/cachedSignUpId");
        if (userId) {
            log.appendLine(`从数据库获取到 userId: ${userId.substring(0, 10)}...`);
            cachedUserId = userId;
            return userId;
        }
    }

    log.appendLine("无法从任何来源获取 userId");
    return null;
}

export async function getAccessToken(forceRefresh = false): Promise<string | null> {
    if (cachedAccessToken && !forceRefresh) return cachedAccessToken;
    cachedAccessToken = null;

    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        log.appendLine(`数据库文件不存在: ${dbPath}`);
        return null;
    }

    // 尝试多个可能的 key
    const keys = [
        "cursorAuth/accessToken",
        "cursorAuth/refreshToken",
    ];

    for (const key of keys) {
        try {
            const token = await queryDb(dbPath, key);
            if (token) {
                log.appendLine(`通过 key "${key}" 获取到 accessToken`);
                cachedAccessToken = token;
                return token;
            }
        } catch (err) {
            log.appendLine(`通过 key "${key}" 查询失败: ${err}`);
        }
    }

    log.appendLine("无法从数据库获取 accessToken");
    return null;
}

async function queryDb(dbPath: string, key: string): Promise<string | null> {
    try {
        const dbSize = fs.statSync(dbPath).size;
        if (dbSize >= MAX_READFILE_SIZE) {
            return await queryDbViaPython(dbPath, key);
        }
        return await queryDbViaSqlJs(dbPath, key);
    } catch (error) {
        if (isFileTooLargeError(error)) {
            return await queryDbViaPython(dbPath, key);
        }
        log.appendLine(`queryDb 异常: ${error}`);
        return null;
    }
}

function getStoragePaths(): string[] {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const paths: string[] = [];

    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        paths.push(
            path.join(appData, "Cursor", "sentry", "scope_v3.json"),
            path.join(appData, "Cursor", "sentry", "session.json"),
            path.join(appData, "Cursor", "User", "globalStorage", "storage.json"),
        );
    } else if (process.platform === "darwin") {
        const base = path.join(home, "Library", "Application Support", "Cursor");
        paths.push(
            path.join(base, "sentry", "scope_v3.json"),
            path.join(base, "sentry", "session.json"),
            path.join(base, "User", "globalStorage", "storage.json"),
        );
    } else {
        const base = path.join(home, ".config", "Cursor");
        paths.push(
            path.join(base, "sentry", "scope_v3.json"),
            path.join(base, "sentry", "session.json"),
            path.join(base, "User", "globalStorage", "storage.json"),
        );
    }
    return paths;
}

function getDbPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
    } else if (process.platform === "darwin") {
        return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
    }
    return path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

async function findUserIdInFile(filePath: string): Promise<string | null> {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");

    try {
        const data = JSON.parse(content);

        if (data.scope?.user?.id) {
            const uid = extractUserId(data.scope.user.id);
            if (uid) return uid;
        }
        if (data.did) {
            const uid = extractUserId(data.did);
            if (uid) return uid;
        }

        return findUserIdRecursive(data);
    } catch {
        const match = content.match(/user_[a-zA-Z0-9]{20,}/);
        return match ? match[0] : null;
    }
}

function extractUserId(oauthId: string): string | null {
    if (!oauthId) return null;
    if (oauthId.includes("|")) {
        const part = oauthId.split("|").find(p => p.startsWith("user_"));
        if (part) return part;
    }
    return oauthId.startsWith("user_") ? oauthId : null;
}

function findUserIdRecursive(obj: any): string | null {
    if (!obj || typeof obj !== "object") return null;
    for (const key in obj) {
        const val = obj[key];
        if (typeof val === "string" && val.startsWith("user_") && val.length > 20) return val;
        if (typeof val === "object") {
            const found = findUserIdRecursive(val);
            if (found) return found;
        }
    }
    return null;
}

async function queryDbViaSqlJs(dbPath: string, key: string): Promise<string | null> {
    try {
        const initSqlJs = require("sql.js");
        const SQL = await initSqlJs();
        const fileBuffer = fs.readFileSync(dbPath);
        const db = new SQL.Database(fileBuffer);
        try {
            const result = db.exec(`SELECT value FROM ItemTable WHERE key = '${key}'`);
            if (result.length > 0 && result[0].values.length > 0) {
                return result[0].values[0][0] as string;
            }
            return null;
        } finally {
            db.close();
        }
    } catch (err) {
        log.appendLine(`sql.js 查询失败 (key=${key}): ${err}, 回退到 Python`);
        return queryDbViaPython(dbPath, key);
    }
}

async function queryDbViaPython(dbPath: string, key: string): Promise<string | null> {
    const cmds = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
    const script =
        `import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); cur = conn.cursor(); ` +
        `cur.execute("SELECT value FROM ItemTable WHERE key = '${key}' LIMIT 1"); ` +
        `row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()`;

    for (const cmd of cmds) {
        try {
            const token = await execFileAsync(cmd, ["-c", script, dbPath]);
            if (token) {
                log.appendLine(`通过 ${cmd} 获取到值 (key=${key})`);
                return token;
            }
        } catch { /* try next */ }
    }
    log.appendLine(`所有 Python 命令均失败 (key=${key})`);
    return null;
}

function execFileAsync(command: string, args: string[]): Promise<string | null> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) { reject(error); return; }
            const trimmed = stdout.trim();
            resolve(trimmed.length > 0 ? trimmed : null);
        });
    });
}

function isFileTooLargeError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ERR_FS_FILE_TOO_LARGE";
}
