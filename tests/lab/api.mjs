import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { inspect } from "./inspect.mjs"

async function serve(cli, options) {
    const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        ...options,
        env: { ...options.env, OPENCODE_SERVER_PASSWORD: "dcp-lab" },
        stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL")
            reject(new Error(`Server startup timed out: ${output}`))
        }, 30000)
        child.on("error", reject)
        child.on("exit", (code) => {
            clearTimeout(timer)
            reject(new Error(`Server exited ${code}: ${output}`))
        })
        for (const stream of [child.stdout, child.stderr])
            stream.on("data", (chunk) => {
                output += chunk
                const match = output.match(/server listening on (http:\/\/\S+)/)
                if (match) {
                    clearTimeout(timer)
                    resolve(match[1])
                }
            })
    })
    async function request(path, body) {
        const response = await fetch(`${url}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Basic ${Buffer.from("opencode:dcp-lab").toString("base64")}`,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        })
        const text = await response.text()
        assert.ok(response.ok, `${path}: ${response.status} ${text}`)
        return text ? JSON.parse(text) : undefined
    }
    return {
        request,
        rpc: async (method, input) =>
            (
                await request(
                    `/api/rpc/dcp/${method}?${new URLSearchParams({ "location[directory]": options.cwd })}`,
                    { input },
                )
            ).output,
        async close() {
            const exited = new Promise((resolve) => child.once("exit", resolve))
            child.kill("SIGINT")
            await exited
            await writeFile(`${options.record}.server`, output)
        },
    }
}

export async function commands(cli, options, sessionID) {
    let server = await serve(cli, options)
    let expected
    let compactID
    try {
        const snapshot = () => server.rpc("snapshot", { sessionID })
        const command = (text) =>
            server.request(`/api/session/${sessionID}/command`, { name: "dcp", text })
        const before = await snapshot()
        assert.equal(before.context.prunedMessageCount, 1)
        assert.equal(before.canCompress, true)
        await server.rpc("manual", { sessionID, enabled: true })
        assert.equal((await snapshot()).manualMode, true)
        await command("manual off")
        assert.equal((await snapshot()).manualMode, false)
        await command("decompress b1")
        assert.equal((await snapshot()).context.prunedMessageCount, 0)
        await command("recompress b1")
        assert.deepEqual((await snapshot()).stats, before.stats)

        const create = async (effect) =>
            (
                await server.request("/api/session", {
                    title: `DCP ${effect}`,
                    agent: "build",
                    model: { providerID: "lab", id: "gpt-5.4" },
                    location: { directory: options.cwd },
                    permissions: [{ action: "compress", resource: "*", effect }],
                })
            ).data.id
        const prompt = async (id, text) => {
            await server.request(`/api/session/${id}/prompt`, { text })
            await server.request(`/api/experimental/session/${id}/wait`, {})
            return (await server.request(`/api/session/${id}/context`)).data
        }
        for (const effect of ["ask", "deny"]) {
            const id = await create(effect)
            const messages = await prompt(id, `OLD_PAYLOAD: Test ${effect}`)
            const data = await server.rpc("snapshot", { sessionID: id })
            assert.equal(data.canCompress, false)
            assert.equal(data.context.prunedMessageCount, 0)
            const calls = messages.flatMap((message) =>
                message.type === "assistant"
                    ? message.content.filter(
                          (part) => part.type === "tool" && part.name === "compress",
                      )
                    : [],
            )
            if (effect === "deny") assert.equal(calls.length, 0)
            else {
                assert.equal(calls.length, 1)
                assert.equal(calls[0].state.status, "error")
                assert.match(JSON.stringify(calls[0].state.error), /not supported/)
            }
        }
        const ids = await Promise.all([create("allow"), create("allow")])
        compactID = ids[0]
        const histories = await Promise.all(
            ids.map((id, index) => prompt(id, `OLD_PAYLOAD: Independent session ${index}`)),
        )
        for (const [index, id] of ids.entries()) {
            const data = await server.rpc("snapshot", { sessionID: id })
            assert.equal(data.context.prunedMessageCount, 1)
            assert.equal(
                histories[index].filter((message) => message.type === "assistant").length,
                2,
            )
        }
        expected = await snapshot()
    } finally {
        await server.close()
    }
    server = await serve(cli, options)
    try {
        assert.deepEqual(
            await server.rpc("snapshot", { sessionID }),
            expected,
            "DCP state changed after server restart",
        )
        await server.request(`/api/session/${compactID}/prompt`, {
            text: "Keep this latest exchange.",
        })
        await server.request(`/api/experimental/session/${compactID}/wait`, {})
        await server.request(`/api/session/${compactID}/compact`, {})
        await server.request(`/api/experimental/session/${compactID}/wait`, {})
        const messages = (await server.request(`/api/session/${compactID}/context`)).data
        assert.ok(
            messages.some(
                (message) => message.type === "compaction" && message.status === "completed",
            ),
        )
        const { captures } = await inspect(options.env.REQUEST_LOG_DIR)
        const requests = captures
            .filter((entry) => entry.type === "http.request" && entry.sessionID === compactID)
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        const primary = requests.filter((entry) => entry.kind === "primary").at(-1).body
        const compact = requests.find((entry) => entry.kind === "compaction").body
        const prefix = compact.input.slice(0, -1) // OpenCode appends its summary instruction after plugin hooks.
        assert.ok(JSON.stringify(prefix).includes("LAB_SUMMARY"))
        assert.ok(!JSON.stringify(prefix).includes("OLD_PAYLOAD"))
        assert.deepEqual(
            prefix,
            primary.input.slice(0, prefix.length),
            "DCP changed the cached compaction prefix",
        )
        assert.deepEqual(
            compact.instructions,
            primary.instructions,
            "DCP changed the system prefix",
        )
    } finally {
        await server.close()
    }
    return {
        rpc: true,
        manual: true,
        decompress: true,
        recompress: true,
        permissions: true,
        concurrent: true,
        restart: true,
        compaction: true,
    }
}
