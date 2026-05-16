import assert from "node:assert/strict"
import test from "node:test"
import { estimateSelectedTokens } from "../lib/compress/summary-limits"
import { createSessionState, type CompressionBlock } from "../lib/state"
import type { SelectionResolution } from "../lib/compress/types"

function createSelection(): SelectionResolution {
    return {
        startReference: {
            kind: "message",
            rawIndex: 0,
            messageId: "msg-a",
        },
        endReference: {
            kind: "message",
            rawIndex: 1,
            messageId: "msg-b",
        },
        messageIds: ["msg-a", "msg-b"],
        messageTokenById: new Map([
            ["msg-a", 10_000],
            ["msg-b", 50],
        ]),
        toolIds: [],
        requiredBlockIds: [1],
    }
}

function createBlock(): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 10_000,
        summaryTokens: 100,
        durationMs: 0,
        mode: "range",
        topic: "Existing block",
        batchTopic: "Existing block",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-a",
        compressMessageId: "msg-compress",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: ["msg-a"],
        directToolIds: [],
        effectiveMessageIds: ["msg-a"],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "existing compressed summary",
    }
}

test("selected token estimate counts consumed blocks as current summaries", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(1, createBlock())

    assert.equal(estimateSelectedTokens(state, createSelection(), [1]), 150)
})
