import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { assignMessageRefs } from "../lib/message-ids"
import { syncCompressionBlocks } from "../lib/messages"
import { Logger } from "../lib/logger"
import {
    createSessionState,
    ensureSessionInitialized,
    loadMessageIdState,
    loadSessionState,
    saveSessionState,
    type CompressionBlock,
    type WithParts,
} from "../lib/state"

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

function sessionFilePath(sessionID: string): string {
    return join(STORAGE_DIR, `${sessionID}.json`)
}

async function cleanupSession(sessionID: string): Promise<void> {
    await fs.rm(sessionFilePath(sessionID), { force: true })
}

function textPart(messageID: string, sessionID: string, text: string) {
    return {
        id: `${messageID}-part`,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function message(
    sessionID: string,
    id: string,
    role: "user" | "assistant",
    created: number,
    text: string,
    summary = false,
): WithParts {
    return {
        info: {
            id,
            role,
            sessionID,
            agent: "assistant",
            model: {
                providerID: "anthropic",
                modelID: "claude-test",
            },
            summary,
            time: { created },
        } as WithParts["info"],
        parts: [textPart(id, sessionID, text)],
    }
}

function client() {
    return {
        session: {
            get: async () => ({ data: { parentID: null } }),
        },
    }
}

function block(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 100,
        summaryTokens: 10,
        durationMs: 0,
        mode: "message",
        topic: "topic",
        batchTopic: "topic",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "msg-compress",
        compressCallId: "call-1",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-a"],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "summary",
        ...overrides,
    }
}

function seedActiveBlockState(state = createSessionState()) {
    const seededBlock = block()
    state.prune.messages.blocksById.set(seededBlock.blockId, seededBlock)
    state.prune.messages.activeBlockIds.add(seededBlock.blockId)
    state.prune.messages.activeByAnchorMessageId.set(seededBlock.anchorMessageId, seededBlock.blockId)
    state.prune.messages.byMessageId.set("msg-a", {
        tokenCount: 100,
        allBlockIds: [seededBlock.blockId],
        activeBlockIds: [seededBlock.blockId],
    })
    state.prune.messages.nextBlockId = 2
    state.prune.messages.nextRunId = 2
    return state
}

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
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: false,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: false,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

test("save/load preserves lastCompaction", async () => {
    const sessionID = `ses_persist_compaction_${process.pid}_${Date.now()}`
    await cleanupSession(sessionID)
    try {
        const state = createSessionState()
        state.sessionId = sessionID
        state.lastCompaction = 123456

        await saveSessionState(state, new Logger(false))
        const persisted = await loadSessionState(sessionID, new Logger(false))

        assert.equal(persisted?.schemaVersion, 1)
        assert.equal(persisted?.lastCompaction, 123456)
    } finally {
        await cleanupSession(sessionID)
    }
})

test("saveSessionState preserves higher on-disk lastCompaction against stale saves", async () => {
    const sessionID = `ses_stale_compaction_${process.pid}_${Date.now()}`
    await cleanupSession(sessionID)
    try {
        const logger = new Logger(false)
        const newerState = createSessionState()
        newerState.sessionId = sessionID
        newerState.lastCompaction = 999
        await saveSessionState(newerState, logger)

        const staleState = createSessionState()
        staleState.sessionId = sessionID
        staleState.lastCompaction = 100
        await saveSessionState(staleState, logger)

        const persisted = await loadSessionState(sessionID, logger)
        assert.equal(persisted?.lastCompaction, 999)
    } finally {
        await cleanupSession(sessionID)
    }
})

test("save/load preserves and validates messageIds", async () => {
    const sessionID = `ses_persist_message_ids_${process.pid}_${Date.now()}`
    await cleanupSession(sessionID)
    try {
        const state = createSessionState()
        state.sessionId = sessionID
        state.messageIds.byRawId.set("msg-a", "m0007")
        state.messageIds.byRawId.set("msg-b", "m0010")
        state.messageIds.byRef.set("m0007", "msg-a")
        state.messageIds.byRef.set("m0010", "msg-b")
        state.messageIds.nextRef = 42

        await saveSessionState(state, new Logger(false))
        const persisted = await loadSessionState(sessionID, new Logger(false))
        const restored = loadMessageIdState(persisted?.messageIds)

        assert.deepEqual(Array.from(restored.byRawId.entries()), [
            ["msg-a", "m0007"],
            ["msg-b", "m0010"],
        ])
        assert.equal(restored.byRef.get("m0007"), "msg-a")
        assert.equal(restored.byRef.get("m0010"), "msg-b")
        assert.equal(restored.nextRef, 42)

        const validated = loadMessageIdState({
            byRawId: {
                first: "m0005",
                invalidFormat: "x0006",
                zero: "m0000",
                duplicate: "m0005",
                later: "m0008",
            },
            nextRef: 6,
        })
        assert.deepEqual(Array.from(validated.byRawId.entries()), [
            ["first", "m0005"],
            ["later", "m0008"],
        ])
        assert.equal(validated.byRef.get("m0005"), "first")
        assert.equal(validated.nextRef, 9)
    } finally {
        await cleanupSession(sessionID)
    }
})

test("loadSessionState accepts old files without lastCompaction or messageIds", async () => {
    const sessionID = `ses_old_state_${process.pid}_${Date.now()}`
    await cleanupSession(sessionID)
    try {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
        await fs.writeFile(
            sessionFilePath(sessionID),
            JSON.stringify(
                {
                    prune: {
                        tools: {},
                        messages: {
                            byMessageId: {},
                            blocksById: {},
                            activeBlockIds: [],
                            activeByAnchorMessageId: {},
                            nextBlockId: 1,
                            nextRunId: 1,
                        },
                    },
                    nudges: { contextLimitAnchors: [] },
                    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
                    lastUpdated: new Date().toISOString(),
                },
                null,
                2,
            ),
        )

        const persisted = await loadSessionState(sessionID, new Logger(false))
        const restored = loadMessageIdState(persisted?.messageIds)

        assert.notEqual(persisted, null)
        assert.equal(persisted?.lastCompaction, undefined)
        assert.equal(restored.byRawId.size, 0)
        assert.equal(restored.byRef.size, 0)
        assert.equal(restored.nextRef, 1)
    } finally {
        await cleanupSession(sessionID)
    }
})

test("native compaction restart preserves blocks and refs", async () => {
    const sessionID = `ses_native_compaction_${process.pid}_${Date.now()}`
    await cleanupSession(sessionID)
    try {
        const persistedState = seedActiveBlockState()
        persistedState.sessionId = sessionID
        persistedState.messageIds.byRawId.set("msg-a", "m0001")
        persistedState.messageIds.byRawId.set("msg-compress", "m0002")
        persistedState.messageIds.byRef.set("m0001", "msg-a")
        persistedState.messageIds.byRef.set("m0002", "msg-compress")
        persistedState.messageIds.nextRef = 3
        await saveSessionState(persistedState, new Logger(false))

        const fullMessages = [
            message(sessionID, "msg-a", "user", 1, "alpha"),
            message(sessionID, "msg-compress", "assistant", 2, "compressed"),
            message(sessionID, "msg-summary", "assistant", 3, "summary", true),
            message(sessionID, "msg-follow", "user", 4, "follow up"),
        ]

        for (let restart = 0; restart < 2; restart++) {
            const state = createSessionState()
            await ensureSessionInitialized(client(), state, sessionID, new Logger(false), fullMessages, false)

            assert.equal(state.lastCompaction, 3)
            assert.equal(state.messageIds.byRawId.get("msg-a"), "m0001")
            assert.equal(state.messageIds.byRawId.get("msg-compress"), "m0002")
            assert.equal(state.messageIds.nextRef, 3)
            assert.equal(state.prune.messages.blocksById.get(1)?.active, true)
            assert.equal(state.prune.messages.activeBlockIds.has(1), true)
            assert.equal(state.prune.messages.byMessageId.get("msg-a")?.activeBlockIds.includes(1), true)
        }
    } finally {
        await cleanupSession(sessionID)
    }
})

test("syncCompressionBlocks keeps missing-origin blocks active for compacted chat windows", () => {
    const state = seedActiveBlockState()
    const logger = new Logger(false)
    const compactedWindow = [
        message("session-1", "msg-summary", "assistant", 3, "summary", true),
        message("session-1", "msg-follow", "user", 4, "follow up"),
    ]

    syncCompressionBlocks(state, logger, compactedWindow)

    assert.equal(state.prune.messages.blocksById.get(1)?.active, true)
    assert.equal(state.prune.messages.blocksById.get(1)?.deactivatedAt, undefined)
    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
    assert.equal(state.prune.messages.activeByAnchorMessageId.get("msg-a"), 1)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-a")?.activeBlockIds, [1])
})

test("syncCompressionBlocks deactivates missing-origin blocks only for authoritative messages", () => {
    const state = seedActiveBlockState()
    const logger = new Logger(false)
    const compactedWindow = [
        message("session-1", "msg-summary", "assistant", 3, "summary", true),
        message("session-1", "msg-follow", "user", 4, "follow up"),
    ]

    syncCompressionBlocks(state, logger, compactedWindow, { authoritative: true })

    assert.equal(state.prune.messages.blocksById.get(1)?.active, false)
    assert.equal(state.prune.messages.activeBlockIds.has(1), false)
    assert.deepEqual(state.prune.messages.byMessageId.get("msg-a")?.activeBlockIds, [])
})

test("chat transform persists assigned message refs before compression", async () => {
    const sessionID = `ses_chat_ref_persist_${process.pid}_${Date.now()}`
    await cleanupSession(sessionID)
    try {
        const state = createSessionState()
        const logger = new Logger(false)
        const handler = createChatMessageTransformHandler(
            client(),
            state,
            logger,
            buildConfig(),
            {
                reload() {},
                getRuntimePrompts() {
                    return {}
                },
            },
            { global: undefined, agents: {} },
        )
        const output = {
            messages: [
                message(sessionID, "msg-user", "user", 1, "hello"),
                message(sessionID, "msg-assistant", "assistant", 2, "hi"),
            ],
        }

        await handler({}, output)
        const persisted = await loadSessionState(sessionID, logger)
        const restored = loadMessageIdState(persisted?.messageIds)

        assert.equal(restored.byRawId.get("msg-user"), "m0001")
        assert.equal(restored.byRawId.get("msg-assistant"), "m0002")
        assert.equal(restored.byRef.get("m0001"), "msg-user")
        assert.equal(restored.byRef.get("m0002"), "msg-assistant")
        assert.equal(restored.nextRef, 3)
    } finally {
        await cleanupSession(sessionID)
    }
})
