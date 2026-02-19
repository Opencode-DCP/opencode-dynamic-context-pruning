import * as fs from "fs"
import * as path from "path"

// =============================================================================
// Dedicated compress diagnostics logger for DCP
// Buffered async file writes, always-on when compress is invoked
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

function truncate(str: string, max: number): string {
    if (str.length <= max) return str
    return `${str.substring(0, max)}...`
}

function formatNumber(n: number): string {
    return n.toLocaleString("en-US")
}

function indent(lines: string, spaces: number): string {
    const prefix = " ".repeat(spaces)
    return lines
        .split("\n")
        .map((line) => (line ? prefix + line : ""))
        .join("\n")
}

function formatValue(value: unknown, depth = 0): string {
    if (value === null) return "null"
    if (value === undefined) return "undefined"
    if (typeof value === "boolean") return value ? "true" : "false"
    if (typeof value === "number") return formatNumber(value)
    if (typeof value === "string") {
        if (value.length > 120) {
            return `"${truncate(value, 120)}"`
        }
        return `"${value}"`
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return "[]"
        if (depth > 3) {
            return `[${value.length} items]`
        }
        const items = value
            .slice(0, 10)
            .map((v) => `- ${formatValue(v, depth + 1)}`)
            .join("\n")
        const omitted = value.length > 10 ? `\n... (${value.length - 10} more)` : ""
        return `\n${indent(items, 2)}${omitted}`
    }

    if (typeof value === "object") {
        const entries = Object.entries(value)
        if (entries.length === 0) return "{}"
        if (depth > 3) {
            return `{${entries.length} keys}`
        }
        const lines = entries
            .slice(0, 15)
            .map(([k, v]) => `${k}: ${formatValue(v, depth + 1)}`)
            .join("\n")
        const omitted = entries.length > 15 ? `\n... (${entries.length - 15} more)` : ""
        return `\n${indent(lines, 2)}${omitted}`
    }

    return String(value)
}

function write(level: Level, category: string, message: string, data?: unknown): void {
    if (!init()) return
    const ts = new Date().toISOString()
    let output = `[${ts}] [${level}] [${category}]\n${indent(message, 2)}`
    if (data !== undefined) {
        const formatted = formatValue(data)
        output += `\n${indent(formatted, 2)}`
    }
    buffer.push(`${output}\n\n`)
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
    STATE: "STATE",
} as const
