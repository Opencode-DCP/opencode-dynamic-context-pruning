import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"

import { createSessionState } from "../lib/state"
import {
    allocateRunId,
    applyCompressionState,
    COMPRESSED_BLOCK_HEADER,
    reserveBlockIds,
    wrapCompressedSummary,
} from "../lib/compress/state"
import { renderBlockForContext, type BlockLike } from "../lib/compress/renderer"
import { getActiveSummaryTokenUsage } from "../lib/state/utils"
import { countTokens } from "../lib/token-utils"
import type { SelectionResolution } from "../lib/compress/types"

const testDataHome = join(tmpdir(), `opencode-dcp-snowball-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-snowball-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

/**
 * Extract the inner body of a stored block.summary, stripping the standard
 * header and dcp-message-id footer. Mirrors the private extractBlockBody
 * helper inside lib/compress/state.ts so the test can simulate a "snowball"
 * model summary that embeds the prior block's body verbatim.
 */
function extractInnerBody(blockSummary: string, blockId: number): string {
    const header = `${COMPRESSED_BLOCK_HEADER}\n`
    const footer = `\n<dcp-message-id>b${blockId}</dcp-message-id>`
    let body = blockSummary
    if (body.startsWith(header)) body = body.slice(header.length)
    else if (body.startsWith(COMPRESSED_BLOCK_HEADER)) body = body.slice(COMPRESSED_BLOCK_HEADER.length)
    if (body.endsWith(footer)) body = body.slice(0, -footer.length)
    return body.trim()
}

function buildSelection(messageId: string, rawIndex: number, requiredBlockIds: number[]): SelectionResolution {
    return {
        startReference: { kind: "message", rawIndex, messageId },
        endReference: { kind: "message", rawIndex, messageId },
        messageIds: [messageId],
        messageTokenById: new Map([[messageId, 100]]),
        toolIds: [],
        requiredBlockIds,
    }
}

/**
 * Drive one sequential compress round, mirroring the wrap → render → apply
 * pipeline that lib/compress/range.ts executes for real range compressions.
 *
 * Each round constructs a modelSummary that VERBATIM embeds the inner body of
 * the prior block. wrapCompressedSummary's exact-substring dedup then collapses
 * that body to a `(bN)` placeholder, which is the snowball fix under test:
 * stored block summaries stay compact even when the model writes verbose
 * inlined-prior-content summaries.
 */
function runCompressRound(
    state: ReturnType<typeof createSessionState>,
    roundNumber: number,
    consumedBlockIds: number[],
): number {
    const [blockId] = reserveBlockIds(state, 1)
    if (blockId === undefined) {
        throw new Error("Failed to reserve block id")
    }

    // Substantial unique content per round so summaryTokens are nontrivial and
    // the rendered expansion is materially larger than the compact stored form.
    const newContent = `Round ${roundNumber} fresh investigation notes about subsystem ${roundNumber}, with findings, hypotheses, and follow-up actions repeated for token weight. `.repeat(8)

    let modelSummary = `Round ${roundNumber}: ${newContent}`
    for (const consumedId of consumedBlockIds) {
        const consumedBlock = state.prune.messages.blocksById.get(consumedId)
        if (!consumedBlock) continue
        const priorBody = extractInnerBody(consumedBlock.summary, consumedId)
        // Embedding the prior body verbatim is the snowball pattern; the dedup
        // pass inside wrapCompressedSummary should collapse it to `(bN)`.
        modelSummary += `\n\nPrior context:\n${priorBody}`
    }

    const consumedBlocks = consumedBlockIds
        .map((id) => state.prune.messages.blocksById.get(id))
        .filter((b): b is NonNullable<typeof b> => b !== undefined)
        .map((b) => ({ id: b.blockId, summary: b.summary, schemaVersion: b.schemaVersion }))

    const wrapResult = wrapCompressedSummary({
        blockId,
        modelSummary,
        consumedBlocks,
        blocksById: state.prune.messages.blocksById,
        mode: "range",
    })

    // Render against a draft Map (Phase 0 Contract A): never mutate
    // state.prune.messages.blocksById before validation succeeds.
    const draftBlock: BlockLike & { summaryTokens: number } = wrapResult.draftBlock
    const draftBlocksById = new Map<number, BlockLike>(state.prune.messages.blocksById)
    draftBlocksById.set(blockId, draftBlock)
    const { renderedTokens } = renderBlockForContext(blockId, draftBlocksById)
    draftBlock.summaryTokens = renderedTokens

    const messageId = `msg-r${roundNumber}`
    const selection = buildSelection(messageId, roundNumber, consumedBlockIds)
    const anchorMessageId = messageId
    const runId = allocateRunId(state)

    applyCompressionState(
        state,
        {
            topic: `Round ${roundNumber}`,
            batchTopic: `Round ${roundNumber}`,
            startId: `m000${roundNumber}`,
            endId: `m000${roundNumber}`,
            mode: "range",
            runId,
            compressMessageId: `compress-msg-${roundNumber}`,
            compressCallId: `compress-call-${roundNumber}`,
            summaryTokens: renderedTokens,
            refBlockIds: wrapResult.refBlockIds,
        },
        selection,
        anchorMessageId,
        blockId,
        wrapResult.storedSummary,
        consumedBlockIds,
    )

    return blockId
}

test("snowball regression: 5 sequential compresses keep stored summaries compact", () => {
    const state = createSessionState()
    state.sessionId = "ses_snowball_regression"

    const ids: number[] = []
    // Round 1: no prior block to consume.
    ids.push(runCompressRound(state, 1, []))
    // Rounds 2–5: each consumes its immediate predecessor, so only the latest
    // block remains active. The model summary embeds the prior body verbatim;
    // wrapCompressedSummary must dedup it to `(bN)` for the chain to stay
    // bounded instead of doubling each round (the snowball symptom).
    for (let round = 2; round <= 5; round++) {
        ids.push(runCompressRound(state, round, [ids[round - 2]]))
    }

    const block1 = state.prune.messages.blocksById.get(ids[0])
    const block4 = state.prune.messages.blocksById.get(ids[3])
    const block5 = state.prune.messages.blocksById.get(ids[4])
    assert.ok(block1 && block4 && block5, "expected all 5 blocks to exist")

    // Assertion 1 — bounded growth: if dedup is working, block5 stores roughly
    // the same compact body as block4 (each round adds only a fixed
    // "Prior context:\n(bN)" suffix). The 1.5x bound is a generous guard
    // against any future regression where prior bodies get re-inlined.
    assert.ok(
        block5.summary.length < block4.summary.length * 1.5,
        `block5.summary.length (${block5.summary.length}) must be < 1.5x block4.summary.length (${block4.summary.length}) to prove no snowball`,
    )

    // Assertion 2 — structural reference: block5 must record block4 in
    // refBlockIds so renderBlockForContext can expand `(b4)` at read time.
    assert.ok(
        Array.isArray(block5.refBlockIds) && block5.refBlockIds.includes(block4.blockId),
        `block5.refBlockIds must include block4.id (${block4.blockId}); got ${JSON.stringify(block5.refBlockIds)}`,
    )
    assert.equal(
        block5.schemaVersion,
        2,
        "block5 must be persisted as schemaVersion 2 (refBlockIds-aware)",
    )

    // Assertion 3 — rendered expansion: getActiveSummaryTokenUsage sums
    // summaryTokens (rendered token counts for v2 blocks). With block5 active
    // and blocks 1–4 consumed, the rendered expansion of block5 walks the full
    // (b4)→(b3)→(b2)→(b1) chain and produces materially more tokens than the
    // compact stored summary's own token count.
    const activeRenderedTokens = getActiveSummaryTokenUsage(state)
    const activeCompactTokenSum = Array.from(state.prune.messages.activeBlockIds).reduce(
        (sum, blockId) => {
            const block = state.prune.messages.blocksById.get(blockId)
            return sum + (block ? countTokens(block.summary) : 0)
        },
        0,
    )
    assert.ok(
        activeRenderedTokens > activeCompactTokenSum,
        `getActiveSummaryTokenUsage (${activeRenderedTokens}) must exceed compact summary token sum (${activeCompactTokenSum}) to prove rendered expansion is in effect`,
    )

    // Sanity: only block5 should be active after the consume chain.
    assert.equal(state.prune.messages.activeBlockIds.size, 1)
    assert.ok(state.prune.messages.activeBlockIds.has(block5.blockId))
})
