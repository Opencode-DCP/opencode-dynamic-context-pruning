import assert from "node:assert/strict"
import { test } from "node:test"
import {
    mkdtemp,
    mkdir,
    readFile,
    readdir,
    writeFile,
    appendFile,
    rename,
    rm,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { watch } from "../readable.mjs"

async function waitJson(file, ready = () => true) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
        try {
            const value = JSON.parse(await readFile(file, "utf8"))
            if (ready(value)) return value
        } catch (error) {
            if (error.code !== "ENOENT") throw error
        }
        await delay(10)
    }
    assert.fail(`Readable file was not published automatically: ${file}`)
}

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "readable-"))
    const raw = join(root, "raw")
    const output = join(root, "readable")
    const folder = join(raw, "ses_test")
    const live = await watch(raw, output)
    t.after(async () => {
        await live.close()
        await rm(root, { recursive: true, force: true })
    })
    await mkdir(folder, { recursive: true })
    const save = async (name, value) => {
        await writeFile(join(folder, name + ".tmp"), JSON.stringify(value))
        await rename(join(folder, name + ".tmp"), join(folder, name))
    }
    return { root, raw, output, folder, save }
}

test("readable HTTP/WS requests appear immediately and responses publish before streams close", async (t) => {
    const { raw, output, folder, save } = await fixture(t)
    const original = {
        model: "test",
        input: [{ role: "user", content: "one\ntwo" }],
    }
    const final = {
        id: "resp_http",
        status: "completed",
        instructions: "Echoed instructions belong in raw logs",
        tools: [{ type: "function", name: "irrelevant_schema" }],
        output: [
            {
                type: "reasoning",
                id: "rs_opaque",
                encrypted_content: "OPAQUE_REASONING",
                summary: [{ type: "summary_text", text: "Readable thought" }],
            },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "héllo 🦊\nnext" }],
            },
        ],
        usage: {
            input_tokens: 20,
            output_tokens: 3,
            input_tokens_details: { cached_tokens: 12 },
            output_tokens_details: { reasoning_tokens: 1 },
            attribution: { items: { huge_internal_breakdown: { input_tokens: 20 } } },
        },
    }
    await save("http.request.json", {
        timestamp: "2026-09-16T10:00:00Z",
        type: "http.request",
        requestID: "http",
        sessionID: "ses_test",
        kind: "title",
        body: original,
    })
    const title = join(output, "ses_test/0001_title_http")
    assert.deepEqual(await waitJson(join(title, "request.json")), original)
    await assert.rejects(readFile(join(title, "response.json")), {
        code: "ENOENT",
    })
    // Real V1/Codex captures may omit this header; the stream still needs assembly.
    await save("http.response.json", { status: 200, contentType: null })
    const sse = [
        { type: "response.created", response: { id: "resp_http", output: [] } },
        { type: "response.completed", response: final },
    ]
        .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
        .join("")
    const bytes = Buffer.from(sse)
    const split = bytes.indexOf(Buffer.from("🦊")) + 1
    await writeFile(join(folder, "http.response.body"), bytes.subarray(0, split))
    await waitJson(join(title, "meta.json"), (meta) => meta.httpStatus === 200)
    await assert.rejects(readFile(join(title, "response.json")), {
        code: "ENOENT",
    })
    await appendFile(join(folder, "http.response.body"), bytes.subarray(split))
    await waitJson(join(title, "response.json"))
    await save("http.end.json", { status: "cancelled" })
    await waitJson(join(title, "meta.json"), (meta) => meta.transportEnd === "cancelled")
    const bodies = [
        {
            type: "response.create",
            model: "test",
            input: [{ role: "user", content: "WS_FULL" }],
        },
        {
            type: "response.create",
            model: "test",
            previous_response_id: "resp_ws",
            input: [{ type: "function_call_output", call_id: "call_1", output: "DONE" }],
        },
    ]
    const call = {
        type: "function_call",
        call_id: "call_1",
        name: "compress",
        arguments: '{"summary":"WS_SUMMARY"}',
    }
    const frames = [
        { type: "ws.open", timestamp: "2026-09-16T10:00:01Z" },
        {
            type: "ws.frame",
            timestamp: "2026-09-16T10:00:01Z",
            direction: "request",
            body: bodies[0],
        },
        {
            type: "ws.frame",
            direction: "response",
            body: { type: "response.output_item.done", output_index: 0, item: call },
        },
        {
            type: "ws.frame",
            direction: "response",
            body: {
                type: "response.completed",
                response: { id: "resp_ws", status: "completed", output: [] },
            },
        },
        {
            type: "ws.frame",
            timestamp: "2026-09-16T10:00:02Z",
            direction: "request",
            body: bodies[1],
        },
        {
            type: "ws.frame",
            direction: "response",
            body: {
                type: "response.completed",
                response: { id: "resp_last", status: "completed", output: [] },
            },
        },
    ].map((event, sequence) => ({
        sessionID: "ses_test",
        connectionID: "socket",
        kind: "primary",
        sequence,
        ...event,
    }))
    const transcript = frames.map((frame) => JSON.stringify(frame) + "\n").join("")
    await writeFile(
        join(folder, "socket.ws.jsonl"),
        frames
            .slice(0, 2)
            .map((frame) => JSON.stringify(frame) + "\n")
            .join(""),
    )
    const first = join(output, "ses_test/0002_primary_websocket")
    assert.deepEqual(await waitJson(join(first, "request.json")), bodies[0])
    await assert.rejects(readFile(join(first, "response.json")), {
        code: "ENOENT",
    })
    await appendFile(
        join(folder, "socket.ws.jsonl"),
        frames
            .slice(2, 4)
            .map((frame) => JSON.stringify(frame) + "\n")
            .join(""),
    )
    await waitJson(join(first, "response.json"))
    await appendFile(
        join(folder, "socket.ws.jsonl"),
        frames
            .slice(4)
            .map((frame) => JSON.stringify(frame) + "\n")
            .join(""),
    )
    await save("context.context.json", {
        timestamp: "2026-09-16T10:00:00Z",
        type: "context",
        kind: "primary",
        messages: [{ role: "user", content: "FULL_CONTEXT" }],
    })
    const { summary, warnings } = await waitJson(
        join(output, "index.json"),
        (index) =>
            index.summary.requests === 3 &&
            index.summary.pending === 0 &&
            index.summary.contexts === 1,
    )
    assert.deepEqual(warnings, [])
    assert.deepEqual(summary, {
        sessions: 1,
        requests: 3,
        http: 1,
        websocket: 2,
        contexts: 1,
        pending: 0,
    })
    const session = join(output, "ses_test")
    const entries = JSON.parse(await readFile(join(session, "index.json")))
    assert.deepEqual(
        entries.map((entry) => entry.directory),
        ["0001_title_http", "0002_primary_websocket", "0003_primary_websocket"],
    )
    assert.equal(entries[0].transportEnd, "cancelled")
    assert.equal(entries[0].protocolComplete, true)
    assert.equal(entries[2].continuation, "incremental")
    assert.equal(entries[2].previous_response_id, "resp_ws")
    assert.deepEqual(
        JSON.parse(await readFile(join(session, entries[0].directory, "response.json"))),
        {
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Readable thought" },
                    { type: "text", text: "héllo 🦊\nnext" },
                ],
            },
            usage: {
                input_tokens: 20,
                output_tokens: 3,
                cached_tokens: 12,
                reasoning_tokens: 1,
            },
        },
    )
    for (const [i, body] of [original, ...bodies].entries()) {
        const text = await readFile(join(session, entries[i].directory, "request.json"), "utf8")
        assert.deepEqual(JSON.parse(text), body)
        assert.ok(text.includes('\n  "'))
    }
    assert.deepEqual(
        JSON.parse(await readFile(join(session, entries[1].directory, "response.json"))).message
            .content,
        [
            {
                type: "tool_use",
                id: "call_1",
                name: "compress",
                input: { summary: "WS_SUMMARY" },
            },
        ],
    )
    assert.equal(await readFile(join(folder, "socket.ws.jsonl"), "utf8"), transcript)
    assert.equal(await readFile(join(folder, "http.response.body"), "utf8"), sse)
    assert.equal((await readdir(session)).filter((name) => /^\d/.test(name)).length, 3)
})

test("partial SSE responses retain text, arguments, and reasoning without claiming completion", async (t) => {
    const { raw, output, folder, save } = await fixture(t)
    await save("a.request.json", {
        timestamp: "2026-09-16",
        requestID: "a",
        body: { input: "test" },
    })
    await save("a.response.json", {
        status: 200,
        contentType: "text/event-stream",
    })
    const events = [
        {
            type: "response.created",
            response: { id: "partial", status: "in_progress", output: [] },
        },
        {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "reasoning", summary: [] },
        },
        {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            summary_index: 0,
            delta: "Thinking",
        },
        {
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "function_call", name: "compress", arguments: "" },
        },
        {
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '{"summary":',
        },
        {
            type: "response.output_item.added",
            output_index: 2,
            item: { type: "message", role: "assistant", content: [] },
        },
        {
            type: "response.output_text.delta",
            output_index: 2,
            content_index: 0,
            delta: "Partial 🦊",
        },
    ]
    await writeFile(
        join(folder, "a.response.body"),
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
            'data: {"type":"response.out',
    )
    await save("a.end.json", { status: "cancelled" })
    const body = await waitJson(join(output, "ses_test/0001_request_http/response.json"))
    const meta = await waitJson(
        join(output, "ses_test/0001_request_http/meta.json"),
        (meta) => meta.transportEnd === "cancelled",
    )
    assert.equal(meta.protocolComplete, false)
    assert.equal(body.message.content[0].thinking, "Thinking")
    assert.equal(body.message.content[1].input, '{"summary":')
    assert.equal(body.message.content[2].text, "Partial 🦊")
})

test("live WS capture tolerates an incomplete final frame and retains provider errors", async (t) => {
    const { output, folder } = await fixture(t)
    const records = [
        {
            type: "ws.frame",
            direction: "request",
            timestamp: "2026-09-16",
            sequence: 1,
            body: { type: "response.create", input: [] },
        },
        {
            type: "ws.frame",
            direction: "response",
            sequence: 2,
            body: { type: "error", error: { code: "previous_response_not_found" } },
        },
        { type: "ws.error", message: "socket closed" },
    ]
    await writeFile(
        join(folder, "a.ws.jsonl"),
        records.map((event) => JSON.stringify(event) + "\n").join("") + '{"type":"ws.',
    )
    const body = await waitJson(join(output, "ses_test/0001_request_websocket/response.json"))
    const meta = await waitJson(
        join(output, "ses_test/0001_request_websocket/meta.json"),
        (meta) => meta.protocolComplete,
    )
    assert.equal(meta.status, "failed")
    assert.equal(body.errors[0].code, "previous_response_not_found")
})

test("a closed socket publishes partial output without waiting for watcher shutdown", async (t) => {
    const { output, folder } = await fixture(t)
    const records = [
        {
            type: "ws.frame",
            direction: "request",
            sequence: 1,
            body: { type: "response.create", input: [] },
        },
        {
            type: "ws.frame",
            direction: "response",
            body: {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", role: "assistant", content: [] },
            },
        },
        {
            type: "ws.frame",
            direction: "response",
            body: {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "Partial reply",
            },
        },
        { type: "ws.close", code: 1006 },
    ]
    await writeFile(
        join(folder, "a.ws.jsonl"),
        records.map((frame) => JSON.stringify(frame) + "\n").join(""),
    )
    const body = await waitJson(join(output, "ses_test/0001_request_websocket/response.json"))
    assert.equal(body.message.content[0].text, "Partial reply")
    const meta = await waitJson(
        join(output, "ses_test/0001_request_websocket/meta.json"),
        (meta) => meta.transportEnd === "closed",
    )
    assert.equal(meta.protocolComplete, false)
})

test("overlapping HTTP requests retain their own responses when completion order reverses", async (t) => {
    const { output, folder, save } = await fixture(t)
    for (const id of ["first", "second"]) {
        await save(`${id}.request.json`, { requestID: id, body: { input: id } })
        await save(`${id}.response.json`, {
            status: 200,
            contentType: "application/json",
        })
    }
    const session = join(output, "ses_test")
    const entries = await waitJson(join(session, "index.json"), (entries) => entries.length === 2)
    for (const id of ["second", "first"]) {
        const body = {
            output: [{ type: "message", content: [{ type: "output_text", text: id }] }],
        }
        await writeFile(join(folder, `${id}.response.body`), JSON.stringify(body))
        await save(`${id}.end.json`, { status: "completed" })
        const entry = entries.find((entry) => entry.requestID === id)
        const result = await waitJson(join(session, entry.directory, "response.json"))
        assert.equal(result.message.content[0].text, id)
        assert.deepEqual(await waitJson(join(session, entry.directory, "request.json")), {
            input: id,
        })
    }
    const index = await waitJson(join(output, "index.json"), (index) => index.summary.pending === 0)
    assert.deepEqual(index.warnings, [])
})
