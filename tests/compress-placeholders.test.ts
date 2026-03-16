import assert from "node:assert/strict"
import test from "node:test"
import type { CompressionBlock } from "../lib/state"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    validateSummaryPlaceholders,
    wrapCompressedSummary,
} from "../lib/tools/utils"

function createBlock(blockId: number, body: string): CompressionBlock {
    return {
        blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        topic: `Block ${blockId}`,
        targetId: `b${blockId}m0001`,
        anchorMessageId: `msg-${blockId}`,
        compressMessageId: `compress-${blockId}`,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [`msg-${blockId}`],
        effectiveToolIds: [],
        createdAt: blockId,
        summary: wrapCompressedSummary(blockId, body),
    }
}

test("compress placeholder validation keeps valid placeholders and ignores invalid ones", () => {
    const summaryByBlockId = new Map([
        [1, createBlock(1, "First compressed summary")],
        [2, createBlock(2, "Second compressed summary")],
    ])
    const summary = "Intro (b1) unknown (b9) duplicate (b1) out-of-range (b2) outro"
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(parsed, [1], summaryByBlockId)

    assert.deepEqual(
        parsed.map((placeholder) => placeholder.blockId),
        [1],
    )
    assert.equal(missingBlockIds.length, 0)

    const injected = injectBlockPlaceholders(summary, parsed, summaryByBlockId)

    assert.match(injected.expandedSummary, /First compressed summary/)
    assert.doesNotMatch(injected.expandedSummary, /Second compressed summary/)
    assert.match(injected.expandedSummary, /\(b9\)/)
    assert.match(injected.expandedSummary, /\(b2\)/)
    assert.deepEqual(injected.consumedBlockIds, [1])
})

test("compress continues by appending required block summaries the model omitted", () => {
    const summaryByBlockId = new Map([[1, createBlock(1, "Recovered compressed summary")]])
    const summary = "The model forgot to include the prior block."
    const parsed = parseBlockPlaceholders(summary)

    const missingBlockIds = validateSummaryPlaceholders(parsed, [1], summaryByBlockId)

    assert.deepEqual(missingBlockIds, [1])

    const injected = injectBlockPlaceholders(summary, parsed, summaryByBlockId)
    const finalSummary = appendMissingBlockSummaries(
        injected.expandedSummary,
        missingBlockIds,
        summaryByBlockId,
        injected.consumedBlockIds,
    )

    assert.match(
        finalSummary.expandedSummary,
        /The following previously compressed summaries were also part of this conversation section:/,
    )
    assert.match(finalSummary.expandedSummary, /### \(b1\)/)
    assert.match(finalSummary.expandedSummary, /Recovered compressed summary/)
    assert.deepEqual(finalSummary.consumedBlockIds, [1])
})
