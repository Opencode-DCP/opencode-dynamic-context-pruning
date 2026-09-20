import { randomUUID } from "node:crypto"
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const defaultDirectory = () =>
    process.env.REQUEST_LOG_DIR ||
    join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "opencode",
        "logs",
        "request-logger",
    )

export interface Scope {
    sessionID: string
    kind?: string
    agent?: string
    model?: unknown
}

export function decode(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

export class Capture {
    constructor(readonly directory = defaultDirectory()) {}

    async write(scope: Scope, id: string, suffix: string, value: unknown) {
        const directory = join(this.directory, encodeURIComponent(scope.sessionID))
        const file = join(directory, `${id}.${suffix}`)
        try {
            await mkdir(directory, { recursive: true, mode: 0o700 })
            if (value instanceof Uint8Array) {
                await appendFile(file, value, { mode: 0o600 })
            } else {
                await writeFile(
                    `${file}.tmp`,
                    JSON.stringify({
                        timestamp: new Date().toISOString(),
                        ...scope,
                        requestID: id,
                        ...(value as object),
                    }),
                    { mode: 0o600 },
                )
                await rename(`${file}.tmp`, file)
            }
        } catch (error) {
            console.error("request-logger: cannot write capture", file, error)
        }
    }

    async request(scope: Scope, request: Request) {
        const id = randomUUID()
        await this.write(scope, id, "request.json", {
            type: "http.request",
            url: request.url,
            method: request.method,
            body: decode(await request.clone().text()),
        })
        return id
    }

    async response(scope: Scope, id: string, response: Response) {
        await this.write(scope, id, "response.json", {
            type: "http.response",
            status: response.status,
            contentType: response.headers.get("content-type"),
        })
        const end = (status: string) =>
            this.write(scope, id, "end.json", { type: "http.end", status })
        if (!response.body) {
            await end("completed")
            return response
        }
        const reader = response.body.getReader()
        const capture = this
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const chunk = await reader.read()
                    if (chunk.done) {
                        await end("completed")
                        controller.close()
                        reader.releaseLock()
                    } else {
                        await capture.write(scope, id, "response.body", chunk.value)
                        controller.enqueue(chunk.value)
                    }
                } catch (error) {
                    await end("error")
                    controller.error(error)
                    reader.releaseLock()
                }
            },
            async cancel(reason) {
                await end("cancelled")
                try {
                    await reader.cancel(reason)
                } finally {
                    reader.releaseLock()
                }
            },
        })
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        })
    }
}
