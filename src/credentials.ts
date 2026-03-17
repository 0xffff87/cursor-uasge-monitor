import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";

const MAX_READFILE_SIZE = 2 * 1024 * 1024 * 1024;

let cachedAccessToken: string | null = null;

export function clearCachedToken(): void {
    cachedAccessToken = null;
}

export async function getUserId(): Promise<string | null> {
    const paths = getStoragePaths();
    for (const p of paths) {
        try {
            const userId = await findUserIdInFile(p);
            if (userId) return userId;
        } catch { /* continue */ }
    }
    return null;
}

export async function getAccessToken(forceRefresh = false): Promise<string | null> {
    if (cachedAccessToken && !forceRefresh) return cachedAccessToken;
    cachedAccessToken = null;

    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return null;

    try {
        const dbSize = fs.statSync(dbPath).size;
        let token: string | null = null;

        if (dbSize >= MAX_READFILE_SIZE) {
            token = await getTokenViaPython(dbPath);
        } else {
            token = await getTokenViaSqlJs(dbPath);
        }

        if (token) {
            cachedAccessToken = token;
        }
        return token;
    } catch (error) {
        if (isFileTooLargeError(error)) {
            const token = await getTokenViaPython(dbPath);
            if (token) cachedAccessToken = token;
            return token;
        }
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

async function getTokenViaSqlJs(dbPath: string): Promise<string | null> {
    try {
        const initSqlJs = require("sql.js");
        const SQL = await initSqlJs({
            locateFile: (file: string) => path.join(__dirname, file),
        });
        const fileBuffer = fs.readFileSync(dbPath);
        const db = new SQL.Database(fileBuffer);
        try {
            const result = db.exec("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'");
            if (result.length > 0 && result[0].values.length > 0) {
                return result[0].values[0][0] as string;
            }
            return null;
        } finally {
            db.close();
        }
    } catch {
        return getTokenViaPython(dbPath);
    }
}

async function getTokenViaPython(dbPath: string): Promise<string | null> {
    const cmds = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
    const script =
        "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); cur = conn.cursor(); " +
        "cur.execute(\"SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1\"); " +
        "row = cur.fetchone(); print(row[0] if row and row[0] else ''); conn.close()";

    for (const cmd of cmds) {
        try {
            const token = await execFileAsync(cmd, ["-c", script, dbPath]);
            if (token) return token;
        } catch { /* try next */ }
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

function isFileTooLargeError(error: unknown): boolean {
    return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ERR_FS_FILE_TOO_LARGE";
}
