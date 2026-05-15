import type { SelectionResolution } from "./types"
import type { SessionState } from "../state"

const MIN_SELECTED_TOKENS_FOR_RATIO_CHECK = 10_000

export function estimateSelectedTokens(
    state: SessionState,
    selection: SelectionResolution,
    consumedBlockIds: number[] = [],
): number {
    let total = 0
    const consumedMessageIds = new Set<string>()

    for (const blockId of consumedBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (!block) {
            continue
        }
        for (const messageId of block.effectiveMessageIds) {
            consumedMessageIds.add(messageId)
        }
    }

    for (const [messageId, tokenCount] of selection.messageTokenById) {
        if (!consumedMessageIds.has(messageId)) {
            total += tokenCount
        }
    }

    for (const blockId of consumedBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block) {
            total += block.summaryTokens
        }
    }

    return total
}

export function assertUsefulCompressedSummary(summaryTokens: number, selectedTokens: number): void {
    // Both sides of this comparison use rendered token semantics for v2 blocks.
    // summaryTokens is set to renderBlockForContext().renderedTokens at creation time (T12).
    if (selectedTokens >= MIN_SELECTED_TOKENS_FOR_RATIO_CHECK && summaryTokens >= selectedTokens) {
        throw new Error(
            `Compression summary is not smaller than the selected content (${summaryTokens} >= ${selectedTokens} tokens). Retry with a concise summary.`,
        )
    }
}
