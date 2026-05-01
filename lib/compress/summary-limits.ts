import type { SelectionResolution } from "./types"
import type { SessionState } from "../state"

const MAX_COMPRESSED_SUMMARY_TOKENS = 60_000
const MIN_SELECTED_TOKENS_FOR_RATIO_CHECK = 10_000

export function estimateSelectedTokens(
    state: SessionState,
    selection: SelectionResolution,
    consumedBlockIds: number[] = [],
): number {
    let total = 0

    for (const tokenCount of selection.messageTokenById.values()) {
        total += tokenCount
    }

    for (const blockId of consumedBlockIds) {
        const block = state.prune.messages.blocksById.get(blockId)
        if (block) {
            total += block.summaryTokens
        }
    }

    return total
}

export function assertUsefulCompressedSummary(
    summaryTokens: number,
    selectedTokens: number,
): void {
    if (summaryTokens > MAX_COMPRESSED_SUMMARY_TOKENS) {
        throw new Error(
            `Compression summary is too large (${summaryTokens} tokens; max ${MAX_COMPRESSED_SUMMARY_TOKENS}). Retry with a shorter, evidence-focused summary.`,
        )
    }

    if (
        selectedTokens >= MIN_SELECTED_TOKENS_FOR_RATIO_CHECK &&
        summaryTokens >= selectedTokens
    ) {
        throw new Error(
            `Compression summary is not smaller than the selected content (${summaryTokens} >= ${selectedTokens} tokens). Retry with a concise summary.`,
        )
    }
}
