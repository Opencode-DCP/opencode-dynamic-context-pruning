import { validateBlockRefs } from "./dag"
import { COMPRESSED_BLOCK_HEADER, deduplicateBlockContent, stripCompactMarkers } from "./dedup"
import { formatBlockRef, formatMessageIdTag } from "../message-ids"
import type { AppliedCompressionResult, CompressionStateInput, SelectionResolution } from "./types"
import type { CompressionBlock, PruneMessagesState, SessionState } from "../state"

export { COMPRESSED_BLOCK_HEADER }

function nextBlockId(state: SessionState): number {
    const next = state.prune.messages.nextBlockId
    if (!Number.isInteger(next) || next < 1) {
        return 1
    }

    return next
}

export function previewBlockIds(state: SessionState, count: number): number[] {
    if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Invalid block reservation count: ${count}`)
    }
    if (count === 0) {
        return []
    }

    const first = nextBlockId(state)
    return Array.from({ length: count }, (_, index) => first + index)
}

export function reserveBlockIds(state: SessionState, count: number): number[] {
    const ids = previewBlockIds(state, count)
    if (ids.length > 0) {
        state.prune.messages.nextBlockId = ids[ids.length - 1] + 1
    }
    return ids
}

export function allocateBlockId(state: SessionState): number {
    const [blockId] = reserveBlockIds(state, 1)
    if (blockId === undefined) {
        throw new Error("Failed to allocate compression block ID")
    }
    return blockId
}

export function allocateRunId(state: SessionState): number {
    const next = state.prune.messages.nextRunId
    if (!Number.isInteger(next) || next < 1) {
        state.prune.messages.nextRunId = 2
        return 1
    }

    state.prune.messages.nextRunId = next + 1
    return next
}

export function attachCompressionDuration(
    messagesState: PruneMessagesState,
    messageId: string,
    callId: string,
    durationMs: number,
): number {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
        return 0
    }

    let updates = 0
    for (const block of messagesState.blocksById.values()) {
        if (block.compressMessageId !== messageId || block.compressCallId !== callId) {
            continue
        }

        block.durationMs = durationMs
        updates++
    }

    return updates
}

/**
 * Wrap a body string in the standard [Compressed conversation section] header
 * and dcp-message-id boundary footer used for stored block summaries.
 * Primitive used by wrapCompressedSummary and by tests that need to construct a
 * stored-form summary directly without dedup.
 */
export function wrapBlockSummary(blockId: number, summary: string): string {
    const header = COMPRESSED_BLOCK_HEADER
    const footer = formatMessageIdTag(formatBlockRef(blockId))
    const body = summary.trim()
    if (body.length === 0) {
        return `${header}\n${footer}`
    }
    return `${header}\n${body}\n\n${footer}`
}

export interface WrapCompressedSummaryArgs {
    blockId: number
    modelSummary: string
    consumedBlocks: ReadonlyArray<{
        id: number
        summary: string
        schemaVersion?: number
    }>
    blocksById: ReadonlyMap<
        number,
        { summary: string; refBlockIds?: number[]; schemaVersion?: number }
    >
    mode: "range" | "message"
}

export interface WrapCompressedSummaryDraftBlock {
    summary: string
    refBlockIds: number[]
    schemaVersion: number
    summaryTokens: number
}

export interface WrapCompressedSummaryResult {
    storedSummary: string
    refBlockIds: number[]
    draftBlock: WrapCompressedSummaryDraftBlock
}

/**
 * Build the stored summary for a newly created compression block.
 *
 * Pipeline:
 *   1. stripCompactMarkers (lib/compress/dedup.ts) removes any prompt-only
 *      marker text the model may have parroted, leaving only bare `(bN)`
 *      refs.
 *   2. deduplicateBlockContent (lib/compress/dedup.ts) performs exact-
 *      substring dedup of consumed block bodies inside the cleaned summary,
 *      plus a defensive rendered-content leak check (T8 step 5).
 *   3. wrapBlockSummary frames the result with the standard
 *      [Compressed conversation section] header and dcp-message-id footer.
 *
 * Phase 0 Contract E: returns { storedSummary, refBlockIds, draftBlock }.
 * draftBlock.summaryTokens is left at 0 here; T12 builds a draft Map, calls
 * renderBlockForContext, and sets the real token count.
 *
 * blocksById and mode are accepted as part of the contract for future
 * expansion (DAG-wide validation, mode-specific framing); the dedup itself
 * uses blocksById to render consumed blocks for the leak check.
 */
export function wrapCompressedSummary(
    args: WrapCompressedSummaryArgs,
): WrapCompressedSummaryResult {
    const { blockId, modelSummary, consumedBlocks, blocksById } = args

    // Strip any compact marker text the model may have parroted from the
    // compression prompt (e.g. `(bN) — existing compressed block [topic: 
    // "..."] — preserve this token exactly, ...`). Stored block summaries
    // must contain only bare `(bN)` refs (Oracle Round 3 gap 1: storage vs
    // prompt separation). stripCompactMarkers is anchored on the literal
    // marker template generated in range-utils.ts so unrelated text that
    // happens to mention (bN) is untouched.
    const cleaned = stripCompactMarkers(modelSummary)

    // Exact-substring + rendered-content dedup of consumed block content,
    // greedy longest-body-first so a short body that happens to be a
    // substring of a longer body does not pre-empt the longer match.
    // Each consumed block is replaced at most once.
    const { deduped, refBlockIds } = deduplicateBlockContent(
        cleaned,
        consumedBlocks,
        blocksById,
    )

    const storedSummary = wrapBlockSummary(blockId, deduped)

    return {
        storedSummary,
        refBlockIds,
        draftBlock: {
            summary: storedSummary,
            refBlockIds,
            schemaVersion: 2,
            summaryTokens: 0,
        },
    }
}

export function applyCompressionState(
    state: SessionState,
    input: CompressionStateInput,
    selection: SelectionResolution,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
): AppliedCompressionResult {
    const messagesState = state.prune.messages
    const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
    const included = [...consumed]

    const effectiveMessageIds = new Set<string>(selection.messageIds)
    const effectiveToolIds = new Set<string>(selection.toolIds)

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            effectiveMessageIds.add(messageId)
        }
        for (const toolId of consumedBlock.effectiveToolIds) {
            effectiveToolIds.add(toolId)
        }
    }

    const initiallyActiveMessages = new Set<string>()
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) {
            initiallyActiveMessages.add(messageId)
        }
    }

    const initiallyActiveToolIds = new Set<string>()
    for (const activeBlockId of messagesState.activeBlockIds) {
        const activeBlock = messagesState.blocksById.get(activeBlockId)
        if (!activeBlock || !activeBlock.active) {
            continue
        }

        for (const toolId of activeBlock.effectiveToolIds) {
            initiallyActiveToolIds.add(toolId)
        }
    }

    const createdAt = Date.now()
    if (input.refBlockIds !== undefined) {
        validateBlockRefs(blockId, input.refBlockIds, messagesState.blocksById)
    }
    const block: CompressionBlock = {
        blockId,
        runId: input.runId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        summaryTokens: input.summaryTokens,
        durationMs: 0,
        mode: input.mode,
        topic: input.topic,
        batchTopic: input.batchTopic,
        startId: input.startId,
        endId: input.endId,
        anchorMessageId,
        compressMessageId: input.compressMessageId,
        compressCallId: input.compressCallId,
        includedBlockIds: included,
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt,
        summary,
    }
    if (input.refBlockIds !== undefined) {
        block.refBlockIds = input.refBlockIds
        block.schemaVersion = 2
    }

    messagesState.blocksById.set(blockId, block)
    messagesState.activeBlockIds.add(blockId)
    messagesState.activeByAnchorMessageId.set(anchorMessageId, blockId)

    const deactivatedAt = Date.now()
    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock || !consumedBlock.active) {
            continue
        }

        consumedBlock.active = false
        consumedBlock.deactivatedAt = deactivatedAt
        consumedBlock.deactivatedByBlockId = blockId
        if (!consumedBlock.parentBlockIds.includes(blockId)) {
            consumedBlock.parentBlockIds.push(blockId)
        }

        messagesState.activeBlockIds.delete(consumedBlockId)
        const mappedBlockId = messagesState.activeByAnchorMessageId.get(
            consumedBlock.anchorMessageId,
        )
        if (mappedBlockId === consumedBlockId) {
            messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
        }
    }

    const removeActiveBlockId = (
        entry: { activeBlockIds: number[] },
        blockIdToRemove: number,
    ): void => {
        if (entry.activeBlockIds.length === 0) {
            return
        }
        entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockIdToRemove)
    }

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            const entry = messagesState.byMessageId.get(messageId)
            if (!entry) {
                continue
            }
            removeActiveBlockId(entry, consumedBlockId)
        }
    }

    for (const messageId of selection.messageIds) {
        const tokenCount = selection.messageTokenById.get(messageId) || 0
        const existing = messagesState.byMessageId.get(messageId)

        if (!existing) {
            messagesState.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds: [blockId],
                activeBlockIds: [blockId],
            })
            continue
        }

        existing.tokenCount = Math.max(existing.tokenCount, tokenCount)
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    for (const messageId of block.effectiveMessageIds) {
        if (selection.messageTokenById.has(messageId)) {
            continue
        }

        const existing = messagesState.byMessageId.get(messageId)
        if (!existing) {
            continue
        }
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    let compressedTokens = 0
    const newlyCompressedMessageIds: string[] = []
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (!entry) {
            continue
        }

        const isNowActive = entry.activeBlockIds.length > 0
        const wasActive = initiallyActiveMessages.has(messageId)

        if (isNowActive && !wasActive) {
            compressedTokens += entry.tokenCount
            newlyCompressedMessageIds.push(messageId)
        }
    }

    const newlyCompressedToolIds: string[] = []
    for (const toolId of effectiveToolIds) {
        if (!initiallyActiveToolIds.has(toolId)) {
            newlyCompressedToolIds.push(toolId)
        }
    }

    block.directMessageIds = [...newlyCompressedMessageIds]
    block.directToolIds = [...newlyCompressedToolIds]

    block.compressedTokens = compressedTokens

    state.stats.pruneTokenCounter += compressedTokens
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0

    return {
        compressedTokens,
        messageIds: selection.messageIds,
        newlyCompressedMessageIds,
        newlyCompressedToolIds,
    }
}
