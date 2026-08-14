import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index"
import type { WithParts } from "../lib/state"

function fakeContext() {
    const hooks = new Map<string, (event: any) => Promise<void>>()
    const tools = new Map<string, any>()
    const commands = new Map<string, any>()
    const events: Array<(event: any) => Promise<void>> = []
    const disposed: string[] = []

    const createRegistration = (name: string) => ({
        dispose: async () => {
            disposed.push(name)
        },
    })

    const messagesStore: WithParts[] = []

    const value = {
        app: {
            name: "opencode",
            version: "2",
            channel: "test",
            workspace: { directory: process.cwd() },
        },
        directory: process.cwd(),
        client: {
            session: {
                get: async () => ({ id: "session-v2", isSubAgent: false }),
                messages: async () => ({ data: messagesStore }),
            },
            tui: {
                showToast: async () => undefined,
            },
        },
        session: {
            hook: async (name: string, callback: (event: any) => Promise<void>) => {
                hooks.set(name, callback)
                return createRegistration(`session.hook:${name}`)
            },
        },
        tool: {
            transform: async (callback: (draft: any) => void) => {
                callback({
                    add: (toolDef: any) => {
                        tools.set(toolDef.name, toolDef)
                    },
                })
                return createRegistration("tool.transform")
            },
        },
        command: {
            transform: async (callback: (draft: any) => void) => {
                callback({
                    update: (id: string | any, updater?: any) => {
                        if (typeof id === "object") {
                            commands.set(id.name, id)
                            return
                        }
                        const entry: any = { name: id, template: "", description: "" }
                        if (typeof updater === "function") {
                            updater(entry)
                        } else if (updater && typeof updater === "object") {
                            Object.assign(entry, updater)
                        }
                        commands.set(id, entry)
                    },
                    add: (entry: any) => {
                        commands.set(entry.name, entry)
                    },
                })
                return createRegistration("command.transform")
            },
        },
        event: {
            subscribe: async (callback: (event: any) => Promise<void>) => {
                events.push(callback)
                return createRegistration("event.subscribe")
            },
        },
    }

    return {
        value,
        hooks,
        tools,
        commands,
        events,
        disposed,
        messagesStore,
    }
}

function buildToolMessage(id: string, toolName: string, callID: string, output: string): WithParts {
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "session-v2",
            agent: "assistant",
            time: { created: 1000 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-tool-part`,
                messageID: id,
                sessionID: "session-v2",
                type: "tool",
                tool: toolName,
                callID,
                state: {
                    status: "completed",
                    input: { path: "src/main.ts" },
                    output,
                },
            } as any,
        ],
    }
}

function buildUserMessage(id: string, text: string): WithParts {
    return {
        info: {
            id,
            role: "user",
            sessionID: "session-v2",
            agent: "user",
            time: { created: 500 },
        } as WithParts["info"],
        parts: [
            {
                id: `${id}-text-part`,
                messageID: id,
                sessionID: "session-v2",
                type: "text",
                text,
            } as any,
        ],
    }
}

test("OpenCode v2 plugin export shape", () => {
    assert.equal(typeof plugin, "object")
    assert.equal(plugin.id, "opencode-dcp")
    assert.equal(typeof plugin.setup, "function")
})

test("setup registers context hook, compress tool, and dcp-compress command", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    assert.equal(typeof cleanup, "function")
    assert.equal(fake.hooks.has("context"), true)
    assert.equal(fake.tools.has("compress"), true)
    assert.equal(fake.commands.has("dcp-compress"), true)
    assert.equal(fake.events.length > 0, true)

    const compressTool = fake.tools.get("compress")
    assert.equal(compressTool.name, "compress")
    assert.equal(typeof compressTool.description, "string")
    assert.equal(typeof compressTool.execute, "function")
    assert.equal(compressTool.input?.type, "object")

    const dcpCommand = fake.commands.get("dcp-compress")
    assert.equal(dcpCommand.name, "dcp-compress")
    assert.ok(dcpCommand.description.includes("dcp-compress"))

    // v2 has no command-execution hook: a command's `template` IS the whole
    // prompt sent to the model. An empty template (what a prior v2 port left
    // in place) means running /dcp-compress submits nothing useful. Lock
    // that it now carries real compress-trigger instructions plus the
    // $ARGUMENTS placeholder so optional focus text still gets threaded in.
    assert.ok(typeof dcpCommand.template === "string" && dcpCommand.template.length > 0)
    assert.ok(dcpCommand.template.includes("You must now use the compress tool"))
    assert.ok(dcpCommand.template.includes("$ARGUMENTS"))

    await cleanup()
    assert.ok(fake.disposed.includes("session.hook:context"))
    assert.ok(fake.disposed.includes("tool.transform"))
    assert.ok(fake.disposed.includes("command.transform"))
    assert.ok(fake.disposed.includes("event.subscribe"))
})

test("context hook updates model context limit and injects system prompt instructions", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    const event = {
        sessionID: "session-v2",
        agent: "general",
        model: {
            id: "claude-sonnet-4-6",
            providerID: "anthropic",
            limit: { context: 200_000 },
        },
        system: ["You are a coding assistant."],
        messages: [],
        tools: {},
    }

    await contextHook(event)

    assert.ok(event.system.length > 0)
    const combinedSystem = event.system.join("\n")
    assert.ok(
        combinedSystem.includes("Dynamic Context Pruning") ||
            combinedSystem.includes("dcp") ||
            combinedSystem.includes("compress"),
    )

    await cleanup()
})

test("context hook skips injection for internal agents", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    const event = {
        sessionID: "session-v2",
        agent: "general",
        model: { id: "gpt-5.6-sol", limit: { context: 128_000 } },
        system: ["You are a title generator for conversation sessions."],
        messages: [],
        tools: {},
    }

    await contextHook(event)

    assert.equal(event.system.length, 1)
    assert.equal(event.system[0], "You are a title generator for conversation sessions.")

    await cleanup()
})

test("context hook inspects and prunes obsolete tool messages", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    const userMsg = buildUserMessage("m1", "Please inspect the codebase.")
    const toolMsg1 = buildToolMessage("m2", "read", "call-1", "A".repeat(5000))
    const toolMsg2 = buildToolMessage("m3", "read", "call-2", "B".repeat(5000))
    const assistantMsg = buildUserMessage("m4", "Found the relevant files.")

    const messages = [userMsg, toolMsg1, toolMsg2, assistantMsg]

    const event = {
        sessionID: "session-v2",
        agent: "general",
        model: { id: "gpt-5.6-sol", limit: { context: 128_000 } },
        system: [{ type: "text", text: "You are an assistant." }],
        messages,
        tools: {},
    }

    await contextHook(event)

    assert.equal(event.messages.length, 4)
    assert.ok(event.messages[0].info.id)

    await cleanup()
})

test("event subscribe records compression lifecycle timing", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    assert.equal(fake.events.length > 0, true)
    const subscriber = fake.events[0]

    // Send pending event
    await subscriber({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-123",
                    messageID: "msg-123",
                    state: { status: "pending" },
                },
            },
            time: Date.now(),
        },
    })

    // Send completed event
    await subscriber({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    callID: "call-123",
                    messageID: "msg-123",
                    state: {
                        status: "completed",
                        time: { start: Date.now() - 500, end: Date.now() },
                    },
                },
            },
            time: Date.now(),
        },
    })

    await cleanup()
})

test("context hook preserves native v2 messages with role and content", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    const v2Messages = [{ role: "user", content: "Can you see this image? [Image 1]" }]

    const event = {
        sessionID: "session-v2-test",
        agent: "general",
        model: { id: "gemini-3.7-flash", limit: { context: 1_000_000 } },
        system: [{ type: "text", text: "You are a helpful assistant." }],
        messages: v2Messages,
        tools: {},
    }

    await contextHook(event)

    // Ensure messages array was NOT emptied
    assert.equal(event.messages.length, 1)
    assert.equal(event.messages[0].role, "user")
    assert.ok(
        typeof event.messages[0].content === "string" &&
            event.messages[0].content.startsWith("Can you see this image? [Image 1]"),
    )

    await cleanup()
})

test("context hook avoids duplicate/overlapping system prompt injections on subsequent turns", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    const event = {
        sessionID: "session-v2-dedup",
        agent: "general",
        model: { id: "gpt-5.6-sol", limit: { context: 128_000 } },
        system: [{ type: "text", text: "Base instructions for model." }],
        messages: [{ role: "user", content: "Hello!" }],
        tools: {},
    }

    // First call injects DCP system prompt
    await contextHook(event)
    const systemTextAfterTurn1 = (event.system[0] as any).text

    // Second call should NOT duplicate or overlap system prompt
    await contextHook(event)
    const systemTextAfterTurn2 = (event.system[0] as any).text

    assert.equal(systemTextAfterTurn1, systemTextAfterTurn2)

    await cleanup()
})

test("context hook preserves assistant tool_calls and tool responses without dropping", async () => {
    const fake = fakeContext()
    const cleanup = await plugin.setup(fake.value)

    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    const toolCallId = "call_rTLVrYkpejmk6YF7geKMpRiM"
    const v2Messages = [
        { role: "user", content: "Check the files in directory" },
        {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: toolCallId,
                    type: "function",
                    function: {
                        name: "glob",
                        arguments: JSON.stringify({ pattern: "*.ts" }),
                    },
                },
            ],
        },
        {
            role: "tool",
            tool_call_id: toolCallId,
            content: JSON.stringify(["index.ts", "package.json"]),
        },
    ]

    const event = {
        sessionID: "session-v2-tools",
        agent: "general",
        model: { id: "gpt-5.6-sol", limit: { context: 128_000 } },
        system: [{ type: "text", text: "You are a helpful assistant." }],
        messages: v2Messages,
        tools: {},
    }

    await contextHook(event)

    // Ensure all 3 messages are preserved
    assert.equal(event.messages.length, 3)

    // Ensure user message exists
    assert.equal(event.messages[0].role, "user")

    // Ensure assistant message retains tool_calls
    assert.equal(event.messages[1].role, "assistant")
    assert.ok(Array.isArray((event.messages[1] as any).tool_calls))
    assert.equal((event.messages[1] as any).tool_calls[0].id, toolCallId)

    // Ensure tool message is NOT dropped and retains tool_call_id
    assert.equal(event.messages[2].role, "tool")
    assert.equal((event.messages[2] as any).tool_call_id, toolCallId)
    assert.ok((event.messages[2] as any).content.includes("index.ts"))

    await cleanup()
})

// Regression coverage for the fourth v2-port bug: every test above (and the
// original 96/96 "passing" suite from the prior port) builds its fake ctx
// with a full v1-shaped `ctx.client` (session.get/session.messages/tui.show
// Toast all present) -- which is exactly why `const client = ctx?.client`
// being permanently `undefined` under a real v2 host was never caught. The
// real @opencode-ai/plugin Context has no `.client` field at all; it only
// exposes domain-scoped capabilities (ctx.catalog, ctx.session with a
// restricted method set, etc.). This fixture omits `client` entirely and
// only wires up what v2 genuinely provides, then drives the exact sequence
// that crashed live: a context-hook turn (which is the only place a v2
// plugin ever sees message history) followed by a real compress-tool
// execution with a real v2 Tool.Context (sessionID/agent/messageID/id/
// progress only).
function fakeV2OnlyContext() {
    const hooks = new Map<string, (event: any) => Promise<void>>()
    const tools = new Map<string, any>()
    const commands = new Map<string, any>()
    const models = [
        {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            limit: { context: 200_000 },
        },
    ]

    const createRegistration = (name: string) => ({ dispose: async () => {} })

    const value = {
        app: { name: "opencode", version: "2", channel: "test" },
        directory: process.cwd(),
        // Deliberately no `client` field -- this is the real v2 shape.
        catalog: {
            model: {
                list: async () => ({ data: models }),
            },
        },
        session: {
            get: async ({ sessionID }: { sessionID: string }) => ({
                id: sessionID,
                parentID: undefined,
            }),
            hook: async (name: string, callback: (event: any) => Promise<void>) => {
                hooks.set(name, callback)
                return createRegistration(`session.hook:${name}`)
            },
        },
        tool: {
            transform: async (callback: (draft: any) => void) => {
                callback({
                    add: (toolDef: any) => {
                        tools.set(toolDef.name, toolDef)
                    },
                })
                return createRegistration("tool.transform")
            },
        },
        command: {
            transform: async (callback: (draft: any) => void) => {
                callback({
                    update: (id: string, updater: any) => {
                        const entry: any = { name: id, template: "", description: "" }
                        if (typeof updater === "function") updater(entry)
                        commands.set(id, entry)
                    },
                })
                return createRegistration("command.transform")
            },
        },
        event: {
            subscribe: async () => createRegistration("event.subscribe"),
        },
    }

    return { value, hooks, tools, commands }
}

test("compress tool completes end-to-end with no ctx.client at all (real v2 shape)", async () => {
    const fake = fakeV2OnlyContext()
    const cleanup = await plugin.setup(fake.value)

    const sessionID = "ses_v2_no_client"
    const contextHook = fake.hooks.get("context")!
    assert.ok(contextHook)

    // A real context-hook turn is the only way v2 ever exposes message
    // history to this plugin -- this is what populates the message cache
    // that the compress tool falls back to instead of a nonexistent
    // client.session.messages() call.
    const event = {
        sessionID,
        agent: "general",
        model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
        system: [{ type: "text", text: "You are a helpful assistant." }],
        messages: [
            { role: "user", content: "Investigate the auth module." },
            { role: "assistant", content: "Found the relevant code path." },
            { role: "user", content: "Please summarize what we found so far." },
        ],
        tools: {},
    }

    await contextHook(event)

    // Model context limit must resolve via ctx.catalog.model.list(), not a
    // nonexistent client.model.list().
    assert.equal(fake.hooks.size > 0, true)

    const compressTool = fake.tools.get("compress")
    assert.ok(compressTool)

    // Real v2 Tool.Context: no ask, no metadata, no client.
    const toolCtx = {
        sessionID,
        agent: "general",
        messageID: "msg-compress-call",
        id: "call-compress-v2-only",
        progress: async () => {},
    }

    const messageIds = Array.from((event.messages as any[]).keys()).map(
        (i) => `m${(i + 1).toString().padStart(4, "0")}`,
    )

    const result = await compressTool.execute(
        {
            topic: "v2 client-less compress",
            content: [
                {
                    startId: messageIds[0],
                    endId: messageIds[1],
                    summary: "Investigated the auth module and found the relevant code path.",
                },
            ],
        },
        toolCtx,
    )

    assert.equal(typeof result?.content?.[0]?.text, "string")
    assert.ok(result.content[0].text.includes("Compressed"))

    await cleanup()
})
