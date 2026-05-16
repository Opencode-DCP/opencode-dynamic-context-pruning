import assert from "node:assert/strict"
import test from "node:test"

import { renderBlockForContext } from "../lib/compress/renderer"
import { createSessionState } from "../lib/state/state"
import { loadPruneMessagesState, serializePruneMessagesState } from "../lib/state/utils"
import type { CompressionBlock } from "../lib/state/types"
import { countTokens } from "../lib/token-utils"

function createV1Block(): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 123,
        summaryTokens: 11,
        durationMs: 0,
        topic: "legacy",
        batchTopic: "legacy",
        startId: "m0001",
        endId: "m0001",
        anchorMessageId: "msg-1",
        compressMessageId: "msg-2",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 1,
        summary: "legacy summary",
    }
}

function createV2Block(): CompressionBlock {
    return {
        blockId: 2,
        runId: 2,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 50,
        summaryTokens: 0,
        durationMs: 0,
        refBlockIds: [1],
        schemaVersion: 2,
        mode: "range",
        topic: "v2",
        batchTopic: "v2",
        startId: "m0002",
        endId: "m0002",
        anchorMessageId: "msg-2",
        compressMessageId: "msg-3",
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [],
        effectiveToolIds: [],
        createdAt: 2,
        summary: "prefix (b1) suffix",
    }
}

test("legacy block without schemaVersion loads as v1", () => {
    const persisted = serializePruneMessagesState(createSessionState().prune.messages)
    persisted.blocksById = { 1: createV1Block() }

    const loaded = loadPruneMessagesState(JSON.parse(JSON.stringify(persisted)))
    const block = loaded.blocksById.get(1)

    assert.ok(block)
    assert.equal(block?.schemaVersion, undefined)
    assert.equal(block?.refBlockIds, undefined)
    assert.equal(block?.summaryTokens, 11)
})

test("unknown block schemaVersion warns and falls back to v1", () => {
    const persisted = serializePruneMessagesState(createSessionState().prune.messages)
    persisted.blocksById = {
        1: {
            ...createV1Block(),
            schemaVersion: 99,
        },
    }

    const loaded = loadPruneMessagesState(JSON.parse(JSON.stringify(persisted)))
    const block = loaded.blocksById.get(1)

    assert.ok(block)
    assert.equal(block?.schemaVersion, 1)
    assert.equal(block?.refBlockIds, undefined)
})

test("v2 blocks render nested v1 content literally", () => {
    const blocks = new Map<number, CompressionBlock>([
        [1, createV1Block()],
        [2, createV2Block()],
    ])

    const rendered = renderBlockForContext(2, blocks)

    assert.equal(rendered.text, "prefix legacy summary suffix")
})

test("v2 summaryTokens reflect rendered v1 expansion size", () => {
    const persisted = serializePruneMessagesState(createSessionState().prune.messages)
    persisted.blocksById = {
        1: { ...createV1Block(), summary: "legacy summary that is longer" },
        2: createV2Block(),
    }

    const loaded = loadPruneMessagesState(JSON.parse(JSON.stringify(persisted)))
    const block = loaded.blocksById.get(2)

    assert.ok(block)
    assert.equal(block?.summaryTokens, countTokens("prefix legacy summary that is longer suffix"))
})
