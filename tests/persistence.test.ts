import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { rm, writeFile, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Logger } from "../lib/logger"
import { saveSessionState, loadAllSessionStats } from "../lib/state/persistence"
import { createSessionState, type CompressionBlock } from "../lib/state"

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

function buildBlock(
    blockId: number,
    runId: number,
    mode: "message" | "range",
    durationMs: number,
): CompressionBlock {
    return {
        blockId,
        runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10,
        summaryTokens: 5,
        durationMs,
        mode,
        topic: `topic-${blockId}`,
        batchTopic: `batch-${runId}`,
        startId: `m${blockId}`,
        endId: `m${blockId}`,
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `origin-${runId}`,
        compressCallId: `call-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [`msg-${blockId}`],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: blockId === 1 ? ["bash"] : [],
        createdAt: blockId,
        summary: `summary-${blockId}`,
    }
}

test("saveSessionState persists derived compression stats", async () => {
    mkdirSync(STORAGE_DIR, { recursive: true })
    const sessionId = `ses_persistence_save_${Date.now()}`
    const filePath = join(STORAGE_DIR, `${sessionId}.json`)
    const state = createSessionState()
    state.sessionId = sessionId
    state.stats.totalPruneTokens = 120
    state.prune.tools.set("read", 1)
    state.prune.messages.byMessageId.set("msg-1", {
        tokenCount: 10,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    state.prune.messages.byMessageId.set("msg-2", {
        tokenCount: 10,
        allBlockIds: [2],
        activeBlockIds: [2],
    })

    const first = buildBlock(1, 10, "message", 225)
    const second = buildBlock(2, 10, "message", 225)
    state.prune.messages.blocksById.set(1, first)
    state.prune.messages.blocksById.set(2, second)
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeBlockIds.add(2)

    try {
        await saveSessionState(state, new Logger(false))
        const saved = JSON.parse(await readFile(filePath, "utf-8"))

        assert.deepEqual(saved.compression, {
            inputTokens: 120,
            summaryTokens: 10,
            durationMs: 225,
            tools: 2,
            messages: 2,
        })
    } finally {
        await rm(filePath, { force: true })
    }
})

test("loadAllSessionStats sums derived stats and uses LEGACY fallback", async () => {
    mkdirSync(STORAGE_DIR, { recursive: true })
    const logger = new Logger(false)
    const before = await loadAllSessionStats(logger)
    const freshId = `ses_persistence_fresh_${Date.now()}`
    const legacyId = `ses_persistence_legacy_${Date.now()}`
    const freshPath = join(STORAGE_DIR, `${freshId}.json`)
    const legacyPath = join(STORAGE_DIR, `${legacyId}.json`)

    const baseState = {
        nudges: {
            contextLimitAnchors: [],
            turnNudgeAnchors: [],
            iterationNudgeAnchors: [],
        },
        lastUpdated: new Date().toISOString(),
    }

    const fresh = {
        ...baseState,
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
        stats: { pruneTokenCounter: 0, totalPruneTokens: 100 },
        compression: {
            inputTokens: 100,
            summaryTokens: 25,
            durationMs: 700,
            tools: 3,
            messages: 4,
        },
    }

    const legacy = {
        ...baseState,
        prune: {
            tools: { read: 1 },
            messages: {
                byMessageId: {
                    "msg-1": { tokenCount: 10, allBlockIds: [1], activeBlockIds: [1] },
                    "msg-2": { tokenCount: 10, allBlockIds: [2], activeBlockIds: [2] },
                },
                blocksById: {
                    "1": buildBlock(1, 20, "message", 300),
                    "2": buildBlock(2, 20, "message", 300),
                    "3": buildBlock(3, 21, "range", 80),
                },
                activeBlockIds: [1, 2, 3],
                activeByAnchorMessageId: { "msg-1": 1, "msg-2": 2, "msg-3": 3 },
                nextBlockId: 4,
                nextRunId: 22,
            },
        },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 90 },
    }

    try {
        await writeFile(freshPath, JSON.stringify(fresh, null, 2), "utf-8")
        await writeFile(legacyPath, JSON.stringify(legacy, null, 2), "utf-8")
        const after = await loadAllSessionStats(logger)

        assert.equal(after.totalTokens - before.totalTokens, 190)
        assert.equal(after.totalSummaryTokens - before.totalSummaryTokens, 40)
        assert.equal(after.totalDurationMs - before.totalDurationMs, 1080)
        assert.equal(after.totalTools - before.totalTools, 5)
        assert.equal(after.totalMessages - before.totalMessages, 6)
        assert.equal(after.sessionCount - before.sessionCount, 2)
    } finally {
        await rm(freshPath, { force: true })
        await rm(legacyPath, { force: true })
    }
})
