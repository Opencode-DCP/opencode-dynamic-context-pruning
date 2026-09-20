import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { WebSocket, WebSocketServer } from "ws"
import { Capture } from "../dist/log.js"
import { setup } from "../dist/v2.js"
import { createRelay } from "../relay.mjs"

async function temporary(t) {
    const dir = await mkdtemp(join(tmpdir(), "request-logger-"))
    t.after(() => rm(dir, { recursive: true, force: true }))
    return dir
}

test("HTTP hooks correlate concurrent sessions and preserve streamed response bytes", async (t) => {
    const directory = await temporary(t)
    const hooks = new Map()
    await setup({
        options: { directory },
        session: { hook: async (name, fn) => hooks.set(name, fn) },
    })
    const requests = ["ses_one", "ses_two"].map((sessionID) => ({
        sessionID,
        kind: "primary",
        agent: "build",
        model: { id: "test", providerID: "test" },
        request: new Request("https://example.com/responses", {
            method: "POST",
            headers: { authorization: "secret" },
            body: JSON.stringify({ input: sessionID }),
        }),
    }))
    await Promise.all(requests.map((event) => hooks.get("http.request")(event)))
    for (const event of requests.reverse()) {
        const chunks = [
            "data: ",
            JSON.stringify({ text: "héllo 🦊", session: event.sessionID }),
            "\n\n",
        ]
        event.response = new Response(
            new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
                    controller.close()
                },
            }),
            { headers: { "content-type": "text/event-stream" } },
        )
        await hooks.get("http.response")(event)
        assert.equal(await event.response.text(), chunks.join(""))
        const folder = join(directory, event.sessionID)
        const files = await readdir(folder)
        const request = JSON.parse(
            await readFile(
                join(
                    folder,
                    files.find((f) => f.endsWith(".request.json")),
                ),
                "utf8",
            ),
        )
        assert.equal(request.body.input, event.sessionID)
        assert.ok(!JSON.stringify(request).includes("secret"))
        assert.equal(
            await readFile(join(folder, `${request.requestID}.response.body`), "utf8"),
            chunks.join(""),
        )
        assert.equal(
            JSON.parse(await readFile(join(folder, `${request.requestID}.end.json`))).status,
            "completed",
        )
        assert.deepEqual(
            [...files].sort(),
            ["request.json", "response.json", "response.body", "end.json"]
                .map((ext) => `${request.requestID}.${ext}`)
                .sort(),
        )
    }
})

test("HTTP capture propagates cancellation to the provider stream", async (t) => {
    const directory = await temporary(t)
    let cancelled = false
    const response = await new Capture(directory).response(
        { sessionID: "ses_cancel" },
        "cancel",
        new Response(
            new ReadableStream({
                pull(controller) {
                    controller.enqueue(new Uint8Array([65]))
                },
                cancel() {
                    cancelled = true
                },
            }),
        ),
    )
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    assert.equal(cancelled, true)
    assert.equal(
        JSON.parse(await readFile(join(directory, "ses_cancel/cancel.end.json"))).status,
        "cancelled",
    )
})

test("relay preserves text/binary frames, upstream headers, and connection reuse", async (t) => {
    const directory = await temporary(t)
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await once(upstream, "listening")
    t.after(() => new Promise((resolve) => upstream.close(resolve)))
    let connections = 0
    upstream.on("connection", (socket, request) => {
        connections++
        assert.equal(request.headers.authorization, "Bearer private")
        socket.on("message", (data, binary) => socket.send(data, { binary }))
    })
    const relay = createRelay({ directory })
    relay.server.listen(0, "127.0.0.1")
    await once(relay.server, "listening")
    t.after(() => relay.close())
    const url = new URL(`ws://127.0.0.1:${relay.server.address().port}/relay`)
    url.searchParams.set("upstream", `ws://127.0.0.1:${upstream.address().port}`)
    url.searchParams.set("session", "ses_ws")
    const socket = new WebSocket(url, { headers: { authorization: "Bearer private" } })
    await once(socket, "open")
    for (const [data, binary] of [
        [JSON.stringify({ type: "response.create", input: "hello" }), false],
        [JSON.stringify({ type: "response.create", previous_response_id: "resp_one" }), false],
        [Buffer.from([0, 255, 42]), true],
    ]) {
        const incoming = once(socket, "message")
        socket.send(data, { binary })
        const [result, isBinary] = await incoming
        assert.deepEqual(result, Buffer.from(data))
        assert.equal(isBinary, binary)
    }
    socket.close(1000, "done")
    await once(socket, "close")
    assert.equal(connections, 1)
    const [file] = await readdir(join(directory, "ses_ws"))
    const raw = await readFile(join(directory, "ses_ws", file), "utf8")
    const events = raw.trim().split("\n").map(JSON.parse)
    assert.equal(events.filter((e) => e.type === "ws.frame").length, 6)
    assert.ok(!raw.includes("private"))
})
