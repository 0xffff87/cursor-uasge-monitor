import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";

const MAX_SQLJS_DB_SIZE = 64 * 1024 * 1024;
const MAX_JSON_FILE_SIZE = 10 * 1024 * 1024;
const TOKEN_CACHE_TTL_MS = 15 * 60 * 1000;
const log = vscode.window.createOutputChannel("Cursor Usage Monitor - Credentials");

let cachedAccessToken: string | null = null;
let cachedUserId: string | null = null;
let tokenCachedAt = 0;

export function clearCachedToken(): void {
    log.appendLine("清除缓存 token");
    cachedAccessToken = null;
    cachedUserId = null;
    tokenCachedAt = 0;
}

export async function getUserId(): Promise<string | null> {
    if (cachedUserId && Date.now() - tokenCachedAt < TOKEN_CACHE_TTL_MS) return cachedUserId;
    cachedUserId = null;

    const paths = getStoragePaths();
    for (const p of paths) {
        try {
            const userId = await findUserIdInFile(p);
            if (userId) {
                log.appendLine("userId 获取成功");
                cachedUserId = userId;
                tokenCachedAt = Date.now();
                return userId;
            }
        } catch {
            log.appendLine("读取存储文件失败");
        }
    }

    const dbPath = getDbPath();
    if (fs.existsSync(dbPath)) {
        const rawUserId = await queryDb(dbPath, "cursorAuth/cachedSignUpId");
        const userId = rawUserId ? extractUserId(rawUserId) : null;
        if (userId) {
            log.appendLine("从数据库获取到 userId");
            cachedUserId = userId;
            tokenCachedAt = Date.now();
            return userId;
        }
    }

    log.appendLine("无法从任何来源获取 userId");
    return null;
}

export async function getAccessToken(forceRefresh = false): Promise<string | null> {
    if (cachedAccessToken && !forceRefresh && Date.now() - tokenCachedAt < TOKEN_CACHE_TTL_MS) return cachedAccessToken;
    cachedAccessToken = null;

    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        log.appendLine("数据库文件不存在");
        return null;
    }

    try {
        const stat = fs.lstatSync(dbPath);
        if (stat.isSymbolicLink()) {
            log.appendLine("数据库路径为符号链接，拒绝访问");
            return null;
        }
    } catch {
        return null;
    }

    const keys = [
        "cursorAuth/accessToken",
    ];

    for (const key of keys) {
        try {
            const token = await queryDb(dbPath, key);
            if (token) {
                log.appendLine("accessToken 获取成功");
                cachedAccessToken = token;
                tokenCachedAt = Date.now();
                return token;
            }
        } catch {
            log.appendLine("accessToken 查询失败");
        }
    }

    log.appendLine("无法从数据库获取 accessToken");
    return null;
}

async function queryDb(dbPath: string, key: string): Promise<string | null> {
    let fd: number | undefined;
    try {
        fd = fs.openSync(dbPath, "r");
        const stat = fs.fstatSync(fd);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            log.appendLine("数据库路径非普通文件，拒绝访问");
            return null;
        }
        if (stat.size >= MAX_SQLJS_DB_SIZE) {
            log.appendLine("数据库过大，使用 Python 查询");
            fs.closeSync(fd);
            fd = undefined;
            return await queryDbViaPython(dbPath, key);
        }
        fs.closeSync(fd);
        fd = undefined;
        return await queryDbViaSqlJs(dbPath, key);
    } catch (error) {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
        if (isFileTooLargeError(error)) {
            log.appendLine("sql.js 文件过大异常，回退到 Python");
            return await queryDbViaPython(dbPath, key);
        }
        log.appendLine("queryDb 异常");
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
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (stat.size > MAX_JSON_FILE_SIZE) {
        log.appendLine("文件过大，跳过");
        return null;
    }
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
        return match ? extractUserId(match[0]) : null;
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

function findUserIdRecursive(obj: any, depth = 0): string | null {
    if (!obj || typeof obj !== "object" || depth > 20) return null;
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === "string" && val.startsWith("user_") && val.length > 20) return val;
        if (typeof val === "object") {
            const found = findUserIdRecursive(val, depth + 1);
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
            const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = $key");
            stmt.bind({ $key: key });
            let value: string | null = null;
            if (stmt.step()) {
                value = stmt.get()[0] as string;
            }
            stmt.free();
            return value;
        } finally {
            db.close();
        }
    } catch {
        log.appendLine("sql.js 查询失败，回退到 Python");
        return queryDbViaPython(dbPath, key);
    }
}

function resolvePythonPath(): string | null {
    const cmds = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
    const { execFileSync } = require("child_process");
    for (const cmd of cmds) {
        try {
            let resolved: string;
            if (process.platform === "win32") {
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

async function queryDbViaPython(dbPath: string, key: string): Promise<string | null> {
    const pythonPath = resolvePythonPath();
    if (!pythonPath) {
        log.appendLine("Python 查询: 未找到可信 Python 解释器");
        return null;
    }

    const script =
        `import sqlite3, sys; conn = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); cur = conn.cursor(); ` +
        `cur.execute("SELECT value FROM ItemTable WHERE key = ? LIMIT 1", (sys.argv[2],)); ` +
        `row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()`;

    try {
        const token = await execFileAsync(pythonPath, ["-c", script, dbPath, key]);
        if (token) {
            log.appendLine("Python 查询成功");
            return token;
        }
    } catch {
        log.appendLine("Python 查询失败");
    }
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

export interface MaxModeInfo {
    maxMode: boolean;
    modelName: string;
    currentMode: string;
}

const REACTIVE_STORAGE_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

export { getDbPath };

export async function getMaxModeInfo(): Promise<MaxModeInfo | null> {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return null;

    try {
        const value = await queryDb(dbPath, REACTIVE_STORAGE_KEY);
        if (!value) return null;

        const data = JSON.parse(value);
        const aiSettings = data.aiSettings;
        const composerState = data.composerState;
        if (!aiSettings?.modelConfig) return null;

        const composerConfig = aiSettings.modelConfig.composer || {};
        const currentMode = composerState?.defaultMode2 || "agent";

        return {
            maxMode: composerConfig.maxMode === true,
            modelName: composerConfig.modelName || "default",
            currentMode,
        };
    } catch {
        log.appendLine("读取 Max Mode 信息失败");
        return null;
    }
}

function isFileTooLargeError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ERR_FS_FILE_TOO_LARGE";
}
