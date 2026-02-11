import * as fs from "fs"
import * as path from "path"

// =============================================================================
// Dedicated compress diagnostics logger for DCP
// Modeled after pocket-universe logger: buffered async file writes, always-on
// Logs to .logs/dcp-compress.log relative to cwd
// =============================================================================

const LOG_DIR = path.join(process.cwd(), ".logs")
const LOG_FILE = path.join(LOG_DIR, "dcp-compress.log")
const WRITE_INTERVAL_MS = 100
const MAX_DATA_CHARS = 20000

let buffer: string[] = []
let scheduled = false
let initialized = false

function init(): boolean {
    if (initialized) return true
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true })
        }
        fs.writeFileSync(LOG_FILE, "")
        initialized = true
        return true
    } catch {
        return false
    }
}

async function flush(): Promise<void> {
    if (buffer.length === 0) {
        scheduled = false
        return
    }
    const chunk = buffer.join("")
    buffer = []
    scheduled = false
    try {
        await fs.promises.appendFile(LOG_FILE, chunk)
    } catch {}
}

function schedule(): void {
    if (!scheduled) {
        scheduled = true
        setTimeout(flush, WRITE_INTERVAL_MS)
    }
}

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

const QUIET_CATEGORIES = new Set(["HOOK", "PRUNE", "INJECT"])

function shouldWrite(level: Level, category: string): boolean {
    if (level === "ERROR" || level === "WARN") {
        return true
    }

    if (QUIET_CATEGORIES.has(category)) {
        return false
    }

    return true
}

function stringifyData(data: unknown): string {
    try {
        const text = JSON.stringify(data)
        if (text.length <= MAX_DATA_CHARS) return text
        return `${text.substring(0, MAX_DATA_CHARS)}... [truncated ${text.length - MAX_DATA_CHARS} chars]`
    } catch {
        return `"[unserializable data]"`
    }
}

function write(level: Level, category: string, message: string, data?: unknown): void {
    if (!init()) return
    if (!shouldWrite(level, category)) return
    const ts = new Date().toISOString()
    const dataStr = data !== undefined ? ` | ${stringifyData(data)}` : ""
    buffer.push(`[${ts}] [${level}] [${category}] ${message}${dataStr}\n`)
    schedule()
}

export const clog = {
    debug: (category: string, message: string, data?: unknown) =>
        write("DEBUG", category, message, data),
    info: (category: string, message: string, data?: unknown) =>
        write("INFO", category, message, data),
    warn: (category: string, message: string, data?: unknown) =>
        write("WARN", category, message, data),
    error: (category: string, message: string, data?: unknown) =>
        write("ERROR", category, message, data),
    flush,
}

export const C = {
    COMPRESS: "COMPRESS",
    BOUNDARY: "BOUNDARY",
    PRUNE: "PRUNE",
    INJECT: "INJECT",
    STATE: "STATE",
    HOOK: "HOOK",
} as const
