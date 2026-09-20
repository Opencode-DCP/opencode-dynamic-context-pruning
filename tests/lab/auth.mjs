import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { authPath, copyAuth, exportAuth, importAuth, restoreAuth } from "/sandbox/auth.mjs"
import { run } from "./process.mjs"
import { events } from "./mock.mjs"

export async function authentication() {
    const root = "/lab/auth-checks"
    await mkdir(root, { recursive: true })
    const env = {
        ...process.env,
        HOME: root,
        PWD: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_CONFIG_DIR: join(root, "config/opencode"),
    }
    const v1Env = { ...env, XDG_DATA_HOME: join(root, "v1") }
    assert.equal(
        authPath(1, { HOME: root, CODEX_HOME: "/unused" }),
        join(root, ".local/share/opencode/auth.json"),
    )
    assert.equal(
        authPath(2, { HOME: root, PATH: "/missing", OPENCODE_DB: "custom.db" }),
        join(root, ".local/share/opencode/custom.db"),
    )

    const headers = []
    const server = createServer((request, response) => {
        request.resume()
        if (request.url.endsWith("/.well-known/opencode")) {
            response.writeHead(200, { "Content-Type": "application/json" })
            response.end(JSON.stringify({ config: {} }))
            return
        }
        headers.push(request.headers.authorization)
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const event of events("AUTH_COPY_OK"))
            response.write(`data: ${JSON.stringify(event)}\n\n`)
        response.end()
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const baseURL = `${origin}/v1`
    try {
        const legacy = {
            lab: { type: "api", key: "fake-key" },
            openai: { type: "api", key: "fake-openai-key" },
            anthropic: {
                type: "oauth",
                access: "fake-access",
                refresh: "fake-refresh",
                expires: Date.now() + 3600000,
            },
            [origin]: { type: "wellknown", key: "EXAMPLE_TOKEN", token: "fake-token" },
        }
        const file = join(root, "v1-auth.json")
        await writeFile(file, JSON.stringify(legacy), { mode: 0o600 })
        const previous = process.env.DCP_AUTH_PATH
        process.env.DCP_AUTH_PATH = file
        const input = join(root, "input.json")
        try {
            copyAuth(1, input)
        } finally {
            if (previous === undefined) delete process.env.DCP_AUTH_PATH
            else process.env.DCP_AUTH_PATH = previous
        }
        await restoreAuth(1, input, "/opt/v1/node_modules/.bin/opencode", v1Env)
        assert.deepEqual(
            JSON.parse(await readFile(join(v1Env.XDG_DATA_HOME, "opencode/auth.json"), "utf8")),
            legacy,
        )
        assert.equal((await stat(input)).mode & 0o777, 0o600)

        const cli = "/opt/v2/node_modules/.bin/opencode2"
        await run(cli, ["auth", "list", "--standalone", "--format", "json"], { env, cwd: root })
        const path = (await run(cli, ["debug", "paths", "db"], { env, cwd: root })).trim()
        const source = new DatabaseSync(path)
        source.exec("CREATE TABLE private_history (text TEXT)")
        source.prepare("INSERT INTO private_history VALUES (?)").run("PRIVATE_SESSION_TEXT")
        const credentials = [
            {
                id: "cred_key",
                integration: "lab",
                active: 1,
                value: { type: "key", key: "fake-key" },
            },
            {
                id: "cred_old",
                integration: "openai",
                active: 0,
                value: { type: "key", key: "fake-inactive-key" },
            },
            {
                id: "cred_oauth",
                integration: "openai",
                active: 1,
                value: {
                    type: "oauth",
                    methodID: "chatgpt-browser",
                    access: "fake-access",
                    refresh: "fake-refresh",
                    expires: Date.now() + 3600000,
                    metadata: { accountID: "fake-account" },
                },
            },
        ]
        for (const entry of credentials)
            source
                .prepare(
                    "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .run(
                    entry.id,
                    entry.integration,
                    entry.id,
                    JSON.stringify(entry.value),
                    entry.active,
                    1,
                    1,
                )
        source
            .prepare("INSERT INTO kv VALUES (?, ?, ?, ?)")
            .run("wellknown:sources", JSON.stringify([origin]), 1, 1)
        source
            .prepare("INSERT INTO kv VALUES (?, ?, ?, ?)")
            .run("private-setting", '"PRIVATE_CONFIG"', 1, 1)
        const rows = source.prepare("SELECT * FROM credential").all()
        const hash = () =>
            readFile(path).then((data) => createHash("sha256").update(data).digest("hex"))
        const before = await hash()
        await exportAuth(path, input)
        assert.equal(await hash(), before)
        assert.deepEqual(source.prepare("SELECT * FROM credential").all(), rows)
        source.close()
        const serialized = await readFile(input, "utf8")
        assert.ok(
            !serialized.includes("PRIVATE_SESSION_TEXT") && !serialized.includes("PRIVATE_CONFIG"),
        )
        const exported = JSON.parse(serialized)
        assert.deepEqual(
            exported.credentials,
            rows.map((row) => ({ ...row })),
        )

        const targetEnv = { ...env, XDG_DATA_HOME: join(root, "target") }
        await restoreAuth(2, input, cli, targetEnv)
        const targetPath = (
            await run(cli, ["debug", "paths", "db"], { env: targetEnv, cwd: root })
        ).trim()
        const target = new DatabaseSync(targetPath)
        assert.deepEqual(target.prepare("SELECT * FROM credential").all(), rows)
        assert.equal(
            target.prepare("SELECT name FROM sqlite_master WHERE name = 'private_history'").get(),
            undefined,
        )
        assert.equal(
            target.prepare("SELECT value FROM kv WHERE key = 'wellknown:sources'").get().value,
            JSON.stringify([origin]),
        )
        target.prepare("INSERT INTO kv VALUES (?, ?, ?, ?)").run("sandbox-setting", '"KEEP"', 1, 1)
        target.close()
        await assert.rejects(
            importAuth(targetPath, {
                credentials: [exported.credentials[0], exported.credentials[0]],
            }),
        )
        const restored = new DatabaseSync(targetPath)
        assert.deepEqual(restored.prepare("SELECT * FROM credential").all(), rows)
        assert.equal(
            restored.prepare("SELECT value FROM kv WHERE key = 'sandbox-setting'").get().value,
            '"KEEP"',
        )
        restored.close()
        await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
        for (const major of [1, 2]) {
            await writeFile(
                join(env.OPENCODE_CONFIG_DIR, "opencode.json"),
                JSON.stringify(
                    major === 1
                        ? {
                              autoupdate: false,
                              model: "lab/gpt-5.4",
                              small_model: "lab/gpt-5.4",
                              provider: {
                                  lab: {
                                      npm: "@ai-sdk/openai",
                                      options: { baseURL },
                                      models: {
                                          "gpt-5.4": { limit: { context: 200000, output: 32000 } },
                                      },
                                  },
                              },
                          }
                        : {
                              update: "disable",
                              model: "lab/gpt-5.4",
                              agents: { title: { model: "lab/gpt-5.4" } },
                              providers: {
                                  lab: {
                                      package: "@opencode/ai/providers/openai/responses",
                                      env: ["LAB_AUTH_KEY"],
                                      settings: { baseURL },
                                      models: {
                                          "gpt-5.4": {
                                              transport: "http",
                                              limit: { context: 200000, output: 32000 },
                                          },
                                      },
                                  },
                              },
                          },
                ),
            )
            const start = headers.length
            const output = await run(
                major === 1 ? "/opt/v1/node_modules/.bin/opencode" : cli,
                [
                    "run",
                    ...(major === 2 ? ["--standalone"] : []),
                    "--format",
                    "json",
                    "Reply AUTH_COPY_OK.",
                ],
                { env: major === 1 ? v1Env : targetEnv, cwd: root },
            )
            assert.ok(output.includes("AUTH_COPY_OK"))
            assert.ok(headers.length > start)
            assert.ok(headers.slice(start).every((header) => header === "Bearer fake-key"))
        }
    } finally {
        await new Promise((resolve) => server.close(resolve))
    }
    return {
        v1Auth: true,
        v2Auth: true,
        accounts: true,
        sourceReadOnly: true,
        sessionsExcluded: true,
        rollback: true,
        providerAuth: true,
    }
}
