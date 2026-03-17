import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { createCompressTool } from "../lib/tools/compress"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { injectMessageIds } from "../lib/messages"

const testDataHome = join(tmpdir(), `opencode-dcp-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-config-tests-${process.pid}`)

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
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            flatSchema: false,
            protectedTools: [],
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            supersedeWrites: {
                enabled: true,
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
    id: string,
    tool: string,
    callID: string,
    input: Record<string, unknown>,
    output: string,
) {
    return {
        id,
        messageID,
        sessionID,
        type: "tool" as const,
        tool,
        callID,
        state: {
            status: "completed" as const,
            input,
            output,
            title: tool,
            metadata: {},
            time: {
                start: 0,
                end: 0,
            },
        },
    }
}

function buildMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-subagent-prompt",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-subagent-prompt", sessionID, "part-1", "Investigate the issue")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "part-2", "I found the relevant code path"),
            ],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart("msg-user-2", sessionID, "part-3", "Please compress the initial findings"),
            ],
        },
    ]
}

test("compress rebuilds subagent message refs after session state was reset", async () => {
    const sessionID = `ses_subagent_compress_${Date.now()}`
    const rawMessages = buildMessages(sessionID)
    const state = createSessionState()
    state.sessionId = "ses_other"
    state.messageIds.byRawId.set("other-message", "b1m0001")
    state.messageIds.byRef.set("b1m0001", "other-message")
    state.messageIds.blockByRawId.set("other-message", 1)
    state.messageIds.nextRef = 2
    state.prune.messages.currentBlockId = 1
    state.prune.messages.nextBlockId = 2

    const logger = new Logger(false)
    const tool = createCompressTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: { parentID: "ses_parent" } }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compress: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Subagent race fix",
            content: [
                {
                    description: "Initial investigation",
                    targetId: "b1m0001",
                    summary: "Captured the initial investigation and follow-up request.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress",
        } as any,
    )

    assert.equal(result, "Compressed 1 messages into [Compressed conversation section].")
    assert.equal(state.sessionId, sessionID)
    assert.equal(state.isSubAgent, true)
    assert.equal(state.messageIds.byRef.get("b1m0001"), "msg-assistant-1")
    assert.equal(state.messageIds.byRef.get("b2m0002"), "msg-user-2")
    assert.equal(state.messageIds.blockByRawId.get("msg-assistant-1"), 1)
    assert.equal(state.messageIds.blockByRawId.get("msg-user-2"), 2)
    assert.equal(state.prune.messages.blocksById.size, 1)
    assert.equal(state.prune.messages.blocksById.get(1)?.targetId, "b1m0001")
    assert.equal(state.prune.messages.currentBlockId, 2)
})

test("compress can handle multiple blocks in one tool call", async () => {
    const sessionID = `ses_multi_compress_${Date.now()}`
    const rawMessages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "first task")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "first reply")],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-user-2", sessionID, "part-3", "second task")],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 4 },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-2", sessionID, "part-4", "second reply")],
        },
    ]

    const state = createSessionState()
    state.sessionId = sessionID

    const logger = new Logger(false)
    const tool = createCompressTool({
        client: {
            session: {
                messages: async () => ({ data: rawMessages }),
                get: async () => ({ data: {} }),
            },
        },
        state,
        logger,
        config: buildConfig(),
        prompts: {
            reload() {},
            getRuntimePrompts() {
                return { compress: "" }
            },
        },
    } as any)

    const result = await tool.execute(
        {
            topic: "Compressing two finished blocks",
            content: [
                {
                    description: "First finished task",
                    targetId: "b1m0001",
                    summary: "Captured the first task and its completed response.",
                },
                {
                    description: "Second finished task",
                    targetId: "b2m0003",
                    summary: "Captured the second task and its completed response.",
                },
            ],
        },
        {
            ask: async () => {},
            metadata: () => {},
            sessionID,
            messageID: "msg-compress-batch",
        } as any,
    )

    assert.equal(
        result,
        "Compressed 4 messages across 2 blocks into [Compressed conversation section].",
    )
    assert.equal(state.prune.messages.blocksById.size, 2)
    assert.equal(state.prune.messages.blocksById.get(1)?.topic, "First finished task")
    assert.equal(state.prune.messages.blocksById.get(2)?.topic, "Second finished task")
    assert.equal(state.prune.messages.blocksById.get(1)?.targetId, "b1m0001")
    assert.equal(state.prune.messages.blocksById.get(2)?.targetId, "b2m0003")
})

test("new turns and tool batches create new stable blocks", () => {
    const sessionID = `ses_block_turns_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID

    const first = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "first request")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-1", sessionID, "part-2", "first reply"),
                toolPart(
                    "msg-assistant-1",
                    sessionID,
                    "tool-part-1",
                    "bash",
                    "call-1",
                    { command: "pwd" },
                    "ok",
                ),
            ],
        },
    ]
    const second = [
        ...first,
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-user-2", sessionID, "part-3", "second request")],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 4 },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-2", sessionID, "part-4", "second reply"),
                toolPart(
                    "msg-assistant-2",
                    sessionID,
                    "tool-part-2",
                    "read",
                    "call-2",
                    { filePath: "/tmp/x" },
                    "done",
                ),
                toolPart(
                    "msg-assistant-2",
                    sessionID,
                    "tool-part-3",
                    "grep",
                    "call-3",
                    { pattern: "x" },
                    "match",
                ),
            ],
        },
    ]

    assignMessageRefs(state, first)
    assert.equal(state.messageIds.byRawId.get("msg-user-1"), "b1m0001")
    assert.equal(state.messageIds.byRawId.get("msg-assistant-1"), "b1m0002")
    assert.equal(state.prune.messages.currentBlockId, 1)

    assignMessageRefs(state, second)
    assert.equal(state.messageIds.byRawId.get("msg-user-2"), "b2m0003")
    assert.equal(state.messageIds.byRawId.get("msg-assistant-2"), "b2m0004")
    assert.equal(state.messageIds.blockByRawId.get("msg-user-2"), 2)
    assert.equal(state.messageIds.blockByRawId.get("msg-assistant-2"), 2)
    assert.equal(state.prune.messages.currentBlockId, 2)
    assert.equal(state.prune.messages.nextBlockId, 3)
})

test("injectMessageIds annotates block tags with priority and tokens", () => {
    const sessionID = `ses_block_priority_${Date.now()}`
    const state = createSessionState()
    state.sessionId = sessionID
    state.systemPromptTokens = 200

    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user-1",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [textPart("msg-user-1", sessionID, "part-1", "small request")],
        },
        {
            info: {
                id: "msg-assistant-1",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 2 },
                tokens: {
                    input: 800,
                    output: 120,
                    reasoning: 0,
                    cache: {
                        read: 0,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [textPart("msg-assistant-1", sessionID, "part-2", "small reply")],
        },
        {
            info: {
                id: "msg-user-2",
                role: "user",
                sessionID,
                agent: "codebase-analyzer",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [textPart("msg-user-2", sessionID, "part-3", "big request")],
        },
        {
            info: {
                id: "msg-assistant-2",
                role: "assistant",
                sessionID,
                agent: "codebase-analyzer",
                time: { created: 4 },
                tokens: {
                    input: 9500,
                    output: 300,
                    reasoning: 0,
                    cache: {
                        read: 0,
                        write: 0,
                    },
                },
            } as WithParts["info"],
            parts: [
                textPart("msg-assistant-2", sessionID, "part-4", "big reply"),
                toolPart(
                    "msg-assistant-2",
                    sessionID,
                    "tool-part-1",
                    "bash",
                    "call-1",
                    { command: "long command" },
                    "large output",
                ),
            ],
        },
    ]

    assignMessageRefs(state, messages)
    injectMessageIds(state, buildConfig(), messages)

    const firstUserPart = messages[0]?.parts[messages[0].parts.length - 1]
    const secondToolPart = messages[3]?.parts.find((part) => part.type === "tool")

    assert.equal(firstUserPart?.type, "text")
    if (firstUserPart?.type === "text") {
        assert.match(
            firstUserPart.text,
            /<dcp-message-id priority="none" tokens="600">b1m0001<\/dcp-message-id>/,
        )
    }

    assert.equal(secondToolPart?.type, "tool")
    if (secondToolPart?.type === "tool" && secondToolPart.state.status === "completed") {
        assert.match(
            String(secondToolPart.state.output),
            /<dcp-message-id priority="very high" tokens="8700">b2m0004<\/dcp-message-id>/,
        )
    }
})
