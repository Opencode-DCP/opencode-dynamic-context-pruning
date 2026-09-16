import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export async function inspect(directory) {
    const captures = []
    async function visit(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = join(folder, entry.name)
            if (entry.isDirectory()) await visit(file)
            else if (file.endsWith(".json")) captures.push(JSON.parse(await readFile(file, "utf8")))
            else if (file.endsWith(".jsonl")) {
                const text = await readFile(file, "utf8")
                captures.push(...text.trim().split("\n").filter(Boolean).map(JSON.parse))
            }
        }
    }
    await visit(directory)
    const count = (type) => captures.filter((entry) => entry.type === type).length
    return {
        captures,
        summary: {
            sessions: [...new Set(captures.map((entry) => entry.sessionID))],
            contexts: count("context"),
            httpRequests: count("http.request"),
            httpResponses: count("http.response"),
            httpCompleted: captures.filter(
                (entry) => entry.type === "http.end" && entry.status === "completed",
            ).length,
            httpCancelled: captures.filter(
                (entry) => entry.type === "http.end" && entry.status === "cancelled",
            ).length,
            wsConnections: count("ws.open"),
            wsRequests: captures.filter(
                (entry) => entry.type === "ws.frame" && entry.direction === "request",
            ).length,
            wsResponses: captures.filter(
                (entry) => entry.type === "ws.frame" && entry.direction === "response",
            ).length,
            errors: count("ws.error"),
        },
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(JSON.stringify((await inspect(process.argv[2])).summary, null, 2))
}
