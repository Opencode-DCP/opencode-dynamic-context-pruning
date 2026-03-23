import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressMessageTool } from "../lib/compress/message"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

const testDataHome = join(tmpdir(), `opencode-dcp-message-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-message-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function toolPart(
    messageID: string,
    sessionID: string,
    callID: string,
    toolName: string,
    output: string,
) {
    return {
        id: `${callID}-part`,
        messageID,
        sessionID,
        type: "tool" as const,
        tool: toolName,
        callID,
        state: {
            status: "completed" as const,
            input: { description: "demo" },
            output,
        },
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "I mapped the code path")],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-2", sessionID, "part-3", "I also ran a task tool"),
                toolPart("msg-assistant-2", sessionID, "call-task-1", "task", "task output body"),
            ],
        },
    ]
}

test("compress message tool appends non-editable format overlay", () => {
    const tool = createCompressMessageTool({
        client: {},
        state: createSessionState(),
        logger: new Logger(false),
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    assert.match(tool.description, /THE FORMAT OF COMPRESS/)
    assert.match(tool.description, /messageId: string/)
    assert.match(tool.description, /Raw message ID only: mNNNN/)
})

test("compress message mode batches individual message summaries", async () => {
    const sessionID = `ses_message_compress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    messageId: "m0002",
                    topic: "Code path note",
                    summary: "Captured the assistant's code-path findings.",
                },
                {
                    messageId: "m0003",
                    topic: "Task output note",
                    summary: "Captured the assistant's task-backed follow-up.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message",
        },
    )

    assert.equal(result, "Compressed 2 messages into [Compressed conversation section].")
    assert.equal(state.prune.messages.blocksById.size, 2)

    const blocks = Array.from(state.prune.messages.blocksById.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )

    assert.equal(blocks[0]?.startId, "m0002")
    assert.equal(blocks[0]?.endId, "m0002")
    assert.equal(blocks[0]?.topic, "Code path note")
    assert.equal(blocks[1]?.startId, "m0003")
    assert.equal(blocks[1]?.endId, "m0003")
    assert.match(
        blocks[1]?.summary || "",
        /The following protected tools were used in this conversation as well:/,
    )
    assert.match(blocks[1]?.summary || "", /Tool: task/)
    assert.match(blocks[1]?.summary || "", /task output body/)
})

test("compress message mode does not partially apply when preparation fails", async () => {
    const sessionID = `ses_message_compress_prepare_fail_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.experimental.allowSubAgents = true

    state.subAgentResultCache.get = (() => {
        throw new Error("cache failure")
    }) as typeof state.subAgentResultCache.get

    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    await assert.rejects(
        tool.execute(
            {
                topic: "Batch stale notes",
                content: [
                    {
                        messageId: "m0002",
                        topic: "Code path note",
                        summary: "Captured the assistant's code-path findings.",
                    },
                    {
                        messageId: "m0003",
                        topic: "Task output note",
                        summary: "Captured the assistant's task-backed follow-up.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-compress-message-prepare-fail",
            },
        ),
        /cache failure/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})

test("compress message mode rejects compressed block ids", async () => {
    const sessionID = `ses_message_compress_reject_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    await assert.rejects(
        tool.execute(
            {
                topic: "Reject block ids",
                content: [
                    {
                        messageId: "b1",
                        topic: "Invalid target",
                        summary: "Should not be accepted.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-compress-message-reject",
            },
        ),
        /Unable to compress any messages\. Found 1 issue:/,
    )
})

test("compress message mode skips protected user message references", async () => {
    const sessionID = `ses_message_compress_protected_user_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.compress.protectUserMessages = true

    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Protected user entries",
            content: [
                {
                    messageId: "BLOCKED",
                    topic: "Protected marker",
                    summary: "Should be skipped.",
                },
                {
                    messageId: "m0001",
                    topic: "Hidden protected ref",
                    summary: "Should also be skipped.",
                },
                {
                    messageId: "m0002",
                    topic: "Valid note",
                    summary: "Captured the assistant's code-path findings.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message-protected-user",
        },
    )

    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.match(result, /^Compressed 1 message into \[Compressed conversation section\]\./)
    assert.match(result, /Skipped 2 issues:/)
    assert.match(result, /messageId BLOCKED refers to a protected message/)
    assert.match(result, /messageId m0001 refers to a protected message/)
})

test("compress message mode allows messages containing compress tool parts", async () => {
    const sessionID = `ses_message_compress_tool_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    rawMessages.push({
        info: {
            id: "msg-assistant-compress",
            role: "assistant",
            sessionID,
            agent: "assistant",
            time: { created: 4 },
        } as WithParts["info"],
        parts: [
            {
                id: "compress-part",
                messageID: "msg-assistant-compress",
                sessionID,
                type: "tool" as const,
                tool: "compress",
                callID: "call-compress-1",
                state: {
                    status: "completed" as const,
                    input: { topic: "Earlier compression" },
                    output: "done",
                },
            },
        ],
    })

    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Compress compress call",
            content: [
                {
                    messageId: "m0004",
                    topic: "Compress tool message",
                    summary: "Captured the earlier compress tool call.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message-allow-compress-tool",
        },
    )

    assert.equal(result, "Compressed 1 message into [Compressed conversation section].")
    assert.equal(state.prune.messages.blocksById.size, 1)
    const block = Array.from(state.prune.messages.blocksById.values())[0]
    assert.equal(block?.startId, "m0004")
})

test("compress message mode sends one aggregated notification for batched messages", async () => {
    const sessionID = `ses_message_compress_notify_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    config.pruneNotification = "detailed"
    config.pruneNotificationType = "toast"

    const toastCalls: string[] = []
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
            tui: {
                showToast: async ({ body }: { body: { message: string } }) => {
                    toastCalls.push(body.message)
                },
            },
        },
        state,
        logger,
        config,
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    await tool.execute(
        {
            topic: "Batch stale notes",
            content: [
                {
                    messageId: "m0002",
                    topic: "Code path note",
                    summary: "Captured the assistant's code-path findings.",
                },
                {
                    messageId: "m0003",
                    topic: "Task output note",
                    summary: "Captured the assistant's task-backed follow-up.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message-notify",
        },
    )

    assert.equal(toastCalls.length, 1)
    assert.match(toastCalls[0] || "", /Compression #1/)
    assert.match(toastCalls[0] || "", /Topic: Batch stale notes/)
    assert.match(toastCalls[0] || "", /Items: 2 messages/)
})

test("compress message mode skips invalid batch entries and reports issues", async () => {
    const sessionID = `ses_message_compress_partial_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Mixed entries",
            content: [
                {
                    messageId: "b1",
                    topic: "Invalid block id",
                    summary: "Should be skipped.",
                },
                {
                    messageId: "m0002",
                    topic: "Valid note",
                    summary: "Captured the assistant's code-path findings.",
                },
                {
                    messageId: "m9999",
                    topic: "Missing message",
                    summary: "Should also be skipped.",
                },
                {
                    messageId: "m0002",
                    topic: "Duplicate valid note",
                    summary: "Duplicate entry should be skipped.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-message-partial",
        },
    )

    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.match(result, /^Compressed 1 message into \[Compressed conversation section\]\./)
    assert.match(result, /Skipped 3 issues:/)
    assert.match(result, /Block IDs like bN are not allowed/)
    assert.match(result, /messageId m9999 is not available in the current conversation context/)
    assert.match(result, /messageId m0002 was selected more than once in this batch\./)
})

test("compress message mode reports issues when every batch entry is skipped", async () => {
    const sessionID = `ses_message_compress_all_invalid_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)
    const tool = createCompressMessageTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: null } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compressMessage: "", compressRange: "" }
            },
        },
    } as any)

    await assert.rejects(
        tool.execute(
            {
                topic: "All invalid",
                content: [
                    {
                        messageId: "b1",
                        topic: "Invalid block id",
                        summary: "Should be skipped.",
                    },
                    {
                        messageId: "m9999",
                        topic: "Missing message",
                        summary: "Should also be skipped.",
                    },
                ],
            },
            {
                ask: async () => {},
                metadata: () => {},
                sessionID,
                messageID: "msg-compress-message-all-invalid",
            },
        ),
        /Unable to compress any messages\. Found 2 issues:/,
    )

    assert.equal(state.prune.messages.blocksById.size, 0)
})
