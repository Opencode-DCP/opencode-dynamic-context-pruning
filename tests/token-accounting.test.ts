import assert from "node:assert/strict"
import test from "node:test"

import { renderBlockForContext } from "../lib/compress/renderer"
import { assertUsefulCompressedSummary } from "../lib/compress/summary-limits"
import { createSessionState, type CompressionBlock } from "../lib/state"
import { getActiveSummaryTokenUsage } from "../lib/state/utils"
import { countTokens } from "../lib/token-utils"

test("v2 blocks use rendered token counts", () => {
    const blocks = new Map<number, CompressionBlock>([
        [
            1,
            {
                blockId: 1,
                summary: Array.from({ length: 20 }, (_, index) => `token${index + 1}`).join(" "),
                refBlockIds: [],
                schemaVersion: 2,
            } as CompressionBlock,
        ],
        [
            2,
            {
                blockId: 2,
                summary: "(b1)",
                refBlockIds: [1],
                schemaVersion: 2,
            } as CompressionBlock,
        ],
    ])

    const { text, renderedTokens } = renderBlockForContext(2, blocks)
    const compactSummary = blocks.get(2)?.summary ?? ""

    assert.ok(text.includes("token1 token2 token3"))
    assert.ok(renderedTokens > compactSummary.length)
})

test("legacy v1 blocks keep stored summaryTokens unchanged", () => {
    const blocks = new Map<number, CompressionBlock>([
        [
            1,
            {
                blockId: 1,
                summary: "compact legacy summary",
                summaryTokens: 7,
            } as CompressionBlock,
        ],
    ])

    const { renderedTokens } = renderBlockForContext(1, blocks)

    assert.equal(renderedTokens, countTokens("compact legacy summary"))
    assert.equal(blocks.get(1)?.summaryTokens, 7)
})

test("assertUsefulCompressedSummary accepts a much smaller summary", () => {
    assert.doesNotThrow(() => {
        assertUsefulCompressedSummary(120, 20_000)
    })
})

test("assertUsefulCompressedSummary rejects summaries that are not smaller", () => {
    assert.throws(() => {
        assertUsefulCompressedSummary(10_000, 10_000)
    }, /not smaller than the selected content/)
})

test("getActiveSummaryTokenUsage sums active block summaryTokens", () => {
    const state = createSessionState()
    state.prune.messages.blocksById.set(
        1,
        {
            blockId: 1,
            runId: 1,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 111,
            durationMs: 0,
            topic: "one",
            startId: "m1",
            endId: "m2",
            anchorMessageId: "",
            compressMessageId: "",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            createdAt: 1,
            summary: "summary one",
        } as CompressionBlock,
    )
    state.prune.messages.blocksById.set(
        2,
        {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 222,
            durationMs: 0,
            topic: "two",
            startId: "m3",
            endId: "m4",
            anchorMessageId: "",
            compressMessageId: "",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            createdAt: 2,
            summary: "summary two",
        } as CompressionBlock,
    )
    state.prune.messages.blocksById.set(
        3,
        {
            blockId: 3,
            runId: 3,
            active: false,
            deactivatedByUser: false,
            compressedTokens: 0,
            summaryTokens: 999,
            durationMs: 0,
            topic: "inactive",
            startId: "m5",
            endId: "m6",
            anchorMessageId: "",
            compressMessageId: "",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [],
            directMessageIds: [],
            directToolIds: [],
            effectiveMessageIds: [],
            effectiveToolIds: [],
            createdAt: 3,
            summary: "summary three",
        } as CompressionBlock,
    )
    state.prune.messages.activeBlockIds.add(1)
    state.prune.messages.activeBlockIds.add(2)
    state.prune.messages.activeBlockIds.add(3)

    assert.equal(getActiveSummaryTokenUsage(state), 333)
})
