import { watch as watchFiles } from "node:fs"
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { pathToFileURL } from "node:url"

const json = async (file) => JSON.parse(await readFile(file, "utf8"))
async function optional(file) {
    try {
        return await json(file)
    } catch (error) {
        if (error.code === "ENOENT") return undefined
        throw error
    }
}
async function save(file, value) {
    await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 })
    await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
    })
    await rename(`${file}.tmp`, file)
}

// Retain one assembled response, not the potentially huge list of token events.
function response() {
    let value = {}
    let complete = false
    let terminalOutput = false
    const items = new Map()
    const types = {}
    const errors = []
    function accept(event) {
        if (!event || typeof event !== "object") return
        const type = event.type || "unknown"
        types[type] = (types[type] || 0) + 1
        if (event.response) value = { ...value, ...event.response }
        if (["response.completed", "response.failed", "response.incomplete"].includes(type)) {
            complete = true
            terminalOutput = Array.isArray(event.response?.output)
        }
        if (type === "error") {
            errors.push(event)
            complete = true
        }
        const index = event.output_index ?? 0
        if (type === "response.output_item.added" || type === "response.output_item.done") {
            items.set(index, structuredClone(event.item))
        }
        const item = items.get(index)
        if (!item) return
        if (["response.content_part.added", "response.content_part.done"].includes(type)) {
            ;(item.content ??= [])[event.content_index] = structuredClone(event.part)
        }
        if (
            [
                "response.reasoning_summary_part.added",
                "response.reasoning_summary_part.done",
            ].includes(type)
        ) {
            ;(item.summary ??= [])[event.summary_index] = structuredClone(event.part)
        }
        if (type === "response.function_call_arguments.delta")
            item.arguments = (item.arguments || "") + event.delta
        if (type === "response.function_call_arguments.done") item.arguments = event.arguments
        if (type === "response.output_text.delta" || type === "response.output_text.done") {
            const part = ((item.content ??= [])[event.content_index ?? 0] ??= {
                type: "output_text",
                text: "",
            })
            part.text = type.endsWith(".done") ? event.text : part.text + event.delta
        }
        if (
            type === "response.reasoning_summary_text.delta" ||
            type === "response.reasoning_summary_text.done"
        ) {
            const part = ((item.summary ??= [])[event.summary_index ?? 0] ??= {
                type: "summary_text",
                text: "",
            })
            part.text = type.endsWith(".done") ? event.text : part.text + event.delta
        }
    }
    return {
        accept,
        get complete() {
            return complete
        },
        result() {
            // Codex may omit output in the final event; the item events still contain it.
            const output =
                terminalOutput && value.output.length
                    ? value.output
                    : [...items].sort(([a], [b]) => a - b).map(([, item]) => item)
            return {
                body: {
                    ...value,
                    status: errors.length ? "failed" : value.status || "incomplete",
                    output,
                    ...(errors.length ? { errors } : {}),
                },
                complete,
                events: types,
                supported: Object.keys(types).some(
                    (type) => type.startsWith("response.") || type === "error",
                ),
            }
        },
    }
}

function simplify(body) {
    if (!Array.isArray(body?.output)) return body
    const content = body.output.flatMap((item) => {
        if (item.type === "message") {
            return (item.content || []).map((part) =>
                part.type === "output_text"
                    ? {
                          type: "text",
                          text: part.text,
                          ...(part.annotations?.length ? { annotations: part.annotations } : {}),
                      }
                    : part,
            )
        }
        if (item.type === "reasoning") {
            return [...(item.summary || []), ...(item.content || [])]
                .filter((part) => part.text)
                .map((part) => ({ type: "thinking", thinking: part.text }))
        }
        if (item.type === "function_call" || item.type === "custom_tool_call") {
            let input = item.type === "function_call" ? item.arguments : item.input
            if (item.type === "function_call" && typeof input === "string") {
                try {
                    input = JSON.parse(input)
                } catch (error) {
                    if (!(error instanceof SyntaxError)) throw error
                }
            }
            return [{ type: "tool_use", id: item.call_id, name: item.name, input }]
        }
        // Keep unfamiliar output types visible rather than silently discarding them.
        return [item]
    })
    const usage = Object.fromEntries(
        Object.entries({
            input_tokens: body.usage?.input_tokens,
            output_tokens: body.usage?.output_tokens,
            total_tokens: body.usage?.total_tokens,
            cached_tokens: body.usage?.input_tokens_details?.cached_tokens,
            cache_write_tokens: body.usage?.input_tokens_details?.cache_write_tokens,
            reasoning_tokens: body.usage?.output_tokens_details?.reasoning_tokens,
        }).filter(([, value]) => value !== undefined),
    )
    return {
        message: { role: "assistant", content },
        ...(Object.keys(usage).length ? { usage } : {}),
        ...(body.error ? { error: body.error } : {}),
        ...(body.errors?.length
            ? { errors: body.errors.map((event) => event.error || event) }
            : {}),
        ...(body.incomplete_details ? { incomplete_details: body.incomplete_details } : {}),
    }
}

function httpStream(contentType) {
    const assembled = response()
    let mode = contentType?.includes("text/event-stream")
        ? "sse"
        : contentType?.includes("json")
          ? "json"
          : undefined
    let buffer = ""
    let data = []
    function flush() {
        const text = data.join("\n")
        data = []
        if (text && text !== "[DONE]") assembled.accept(JSON.parse(text))
    }
    return {
        get complete() {
            return assembled.complete
        },
        push(text) {
            buffer += text
            // Codex may omit Content-Type. Wait for enough bytes to identify SSE.
            if (!mode && buffer.includes("\n"))
                mode = /^(?:(?:event|data|id|retry):|:)/.test(buffer.trimStart()) ? "sse" : "json"
            if (mode !== "sse") return
            let index
            while ((index = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, index).replace(/\r$/, "")
                buffer = buffer.slice(index + 1)
                if (!line) flush()
                else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
            }
        },
        result(ended = false) {
            if (mode === "sse") {
                if (ended) {
                    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""))
                    try {
                        flush()
                    } catch (error) {
                        if (!(error instanceof SyntaxError)) throw error
                    }
                }
                return assembled.result()
            }
            if (!ended) return
            try {
                return { body: JSON.parse(buffer), complete: true, supported: true }
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error
            }
        },
    }
}

/** Watch raw captures, reading appended bytes once and publishing completed responses. */
export async function watch(directory, destination = join(directory, "readable")) {
    directory = resolve(directory)
    destination = resolve(destination)
    if (directory === destination)
        throw new Error("Readable output must differ from the raw directory.")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const sessions = new Map()
    const http = new Map()
    const sockets = new Map()
    const tails = new Map()
    const pending = new Set()
    const dirty = new Set()
    const warnings = []
    let timer
    let closing
    let running = Promise.resolve()
    function session(file) {
        const id = basename(resolve(file, ".."))
        if (!sessions.has(id))
            sessions.set(id, {
                id,
                path: join(destination, id),
                requests: [],
                contexts: new Set(),
            })
        return sessions.get(id)
    }
    function changed(entry) {
        dirty.add(entry.session)
    }
    async function request(file, record, transport) {
        const state = session(file)
        const kind = record.kind || "request"
        const name = `${String(state.requests.length + 1).padStart(4, "0")}_${kind.replace(/[^a-z0-9_-]/gi, "_")}_${transport}`
        const path = join(state.path, name)
        const meta = {
            timestamp: record.timestamp,
            transport,
            kind,
            model: record.body?.model,
            requestID: record.requestID,
            connectionID: record.connectionID,
            sequence: record.sequence,
            continuation: record.body?.previous_response_id ? "incremental" : "full",
            previous_response_id: record.body?.previous_response_id,
            raw: relative(path, file),
            protocolComplete: false,
        }
        const entry = { session: state, path, meta }
        state.requests.push(entry)
        await save(join(path, "request.json"), record.body)
        await finish(entry)
        return entry
    }
    async function finish(entry, assembled) {
        if (assembled) {
            await save(join(entry.path, "response.json"), simplify(assembled.body))
            Object.assign(entry.meta, {
                responseID: assembled.body?.id,
                status: assembled.body?.status,
                protocolComplete: assembled.complete,
                events: assembled.events,
                assembled: assembled.supported,
            })
        }
        await save(join(entry.path, "meta.json"), entry.meta)
        changed(entry)
    }
    async function tail(file, consume) {
        let handle
        try {
            handle = await open(file, "r")
        } catch (error) {
            if (error.code === "ENOENT") return
            throw error
        }
        if (!tails.has(file)) tails.set(file, { offset: 0, decoder: new StringDecoder("utf8") })
        const state = tails.get(file)
        const buffer = Buffer.alloc(65536)
        try {
            while (true) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset)
                if (!bytesRead) break
                state.offset += bytesRead
                await consume(state.decoder.write(buffer.subarray(0, bytesRead)))
            }
        } finally {
            await handle.close()
        }
    }
    async function readHttp(prefix) {
        let state = http.get(prefix)
        if (state?.ended) return
        if (!state) {
            const record = await optional(`${prefix}request.json`)
            if (!record) return
            state = { entry: await request(`${prefix}request.json`, record, "http") }
            state.entry.meta.url = record.url
            http.set(prefix, state)
        }
        const end = await optional(`${prefix}end.json`)
        if (!state.headers) state.headers = await optional(`${prefix}response.json`)
        if (state.headers && !state.rendered) {
            state.stream ??= httpStream(state.headers.contentType)
            await tail(`${prefix}response.body`, (text) => state.stream.push(text))
            if (state.stream.complete || end) {
                await finish(state.entry, state.stream.result(!!end))
                state.rendered = true
                state.stream = undefined
                tails.delete(`${prefix}response.body`)
            }
        }
        const meta = state.entry.meta
        const ending = end?.status || "pending"
        if (meta.httpStatus !== state.headers?.status || meta.transportEnd !== ending) {
            Object.assign(meta, {
                httpStatus: state.headers?.status,
                transportEnd: ending,
                error: end?.error,
            })
            await finish(state.entry)
        }
        state.ended = !!end
    }
    async function readSocket(file) {
        if (!sockets.has(file)) sockets.set(file, { buffer: "", events: [] })
        const state = sockets.get(file)
        await tail(file, async (text) => {
            state.buffer += text
            let index
            while ((index = state.buffer.indexOf("\n")) !== -1) {
                const line = state.buffer.slice(0, index)
                state.buffer = state.buffer.slice(index + 1)
                if (!line.trim()) continue
                const frame = JSON.parse(line)
                if (
                    frame.type === "ws.frame" &&
                    frame.direction === "request" &&
                    frame.body?.type === "response.create"
                ) {
                    if (state.assembled) await finish(state.entry, state.assembled.result())
                    state.entry = await request(file, frame, "websocket")
                    state.assembled = response()
                } else if (
                    frame.type === "ws.frame" &&
                    frame.direction === "response" &&
                    !frame.binary
                ) {
                    state.assembled?.accept(frame.body)
                    if (state.assembled?.complete) {
                        await finish(state.entry, state.assembled.result())
                        state.assembled = undefined
                    }
                } else if (frame.type !== "ws.frame") {
                    state.events.push(frame)
                    if (
                        (frame.type === "ws.close" || frame.type === "ws.error") &&
                        state.assembled
                    ) {
                        state.entry.meta.transportEnd =
                            frame.type === "ws.error" ? "error" : "closed"
                        await finish(state.entry, state.assembled.result())
                        state.assembled = undefined
                    }
                    await save(
                        join(
                            session(file).path,
                            "connections",
                            `${basename(file, ".ws.jsonl")}.json`,
                        ),
                        state.events,
                    )
                }
            }
        })
    }
    async function visit(file) {
        if (file === destination || file.startsWith(destination + "/") || file.endsWith(".tmp"))
            return
        let info
        try {
            info = await stat(file)
        } catch (error) {
            if (error.code === "ENOENT") return
            throw error
        }
        if (info.isDirectory()) {
            for (const name of await readdir(file)) pending.add(join(file, name))
        } else if (file.endsWith(".context.json")) {
            const state = session(file)
            if (state.contexts.has(file)) return
            const context = await json(file)
            state.contexts.add(file)
            await save(
                join(
                    state.path,
                    "context",
                    `${String(state.contexts.size).padStart(4, "0")}_${context.kind || "context"}.json`,
                ),
                context,
            )
            dirty.add(state)
        } else if (file.endsWith(".ws.jsonl")) {
            await readSocket(file)
        } else if (/\.(request\.json|response\.json|response\.body|end\.json)$/.test(file)) {
            await readHttp(
                file.replace(/(request\.json|response\.json|response\.body|end\.json)$/, ""),
            )
        }
    }
    async function publish() {
        for (const state of dirty) {
            await save(
                join(state.path, "index.json"),
                state.requests.map(({ path, meta }) => ({
                    directory: basename(path),
                    ...meta,
                })),
            )
        }
        dirty.clear()
        const states = [...sessions.values()]
        const requests = states.flatMap((state) => state.requests)
        const summary = {
            sessions: states.length,
            requests: requests.length,
            http: requests.filter(({ meta }) => meta.transport === "http").length,
            websocket: requests.filter(({ meta }) => meta.transport === "websocket").length,
            contexts: states.reduce((sum, state) => sum + state.contexts.size, 0),
            pending: requests.filter(({ meta }) => !meta.protocolComplete).length,
        }
        await save(join(destination, "index.json"), {
            format: "opencode-request-logger/readable",
            sessions: states.map((state) => ({
                directory: state.id,
                requests: state.requests.length,
                contexts: state.contexts.size,
            })),
            warnings,
            summary,
        })
    }
    function report(file, error) {
        warnings.push({ file: relative(directory, file), message: error.message })
        console.error("request-logger: readable capture failed", file, error)
    }
    async function drain() {
        while (pending.size) {
            const files = [...pending]
            pending.clear()
            for (const file of files) {
                try {
                    await visit(file)
                } catch (error) {
                    report(file, error)
                }
            }
        }
        if (dirty.size) await publish()
    }
    const watcher = watchFiles(directory, { recursive: true }, (_event, name) => {
        if (!name) return
        pending.add(join(directory, name))
        if (!timer)
            timer = setTimeout(() => {
                timer = undefined
                running = running.then(drain).catch((error) => report(directory, error))
            }, 10)
    })
    watcher.on("error", (error) => report(directory, error))
    // Watch before scanning so files created during startup cannot be missed.
    pending.add(directory)
    running = (async () => {
        await drain()
        await publish()
    })()
    await running
    return {
        close() {
            return (closing ??= (async () => {
                watcher.close()
                clearTimeout(timer)
                await running
                pending.add(directory)
                await drain()
                for (const state of [...http.values(), ...sockets.values()]) {
                    const assembled = state.stream?.result(true) || state.assembled?.result()
                    if (!assembled) continue
                    state.entry.meta.transportEnd = "interrupted"
                    await finish(state.entry, assembled)
                }
                await publish()
            })())
        },
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!process.argv[2])
        throw new Error(
            "Usage: node readable.mjs RAW_DIRECTORY [OUTPUT_DIRECTORY] (watches until stopped)",
        )
    const watcher = await watch(process.argv[2], process.argv[3])
    console.log("Watching raw captures for readable requests and responses.")
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void watcher.close())
}
