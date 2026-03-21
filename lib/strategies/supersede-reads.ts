import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { getFilePathsFromParameters, isFilePathProtected } from "../protected-patterns"
import { getTotalToolTokens } from "./utils"

/**
 * Supersede Reads strategy - prunes read tool outputs for files that have
 * subsequently been written or edited. When a file is read and later modified,
 * the original read output becomes stale since the file contents have changed.
 *
 * Only prunes reads that are followed by a *successful* write/edit to the same
 * file. Errored writes do not supersede reads because the file was not actually
 * changed.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const supersedeReads = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) {
        return
    }

    if (!config.strategies.supersedeReads.enabled) {
        return
    }

    const allToolIds = state.toolIdList
    if (allToolIds.length === 0) {
        return
    }

    // Filter out IDs already pruned
    const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))
    if (unprunedIds.length === 0) {
        return
    }

    // Track read tools by file path: filePath -> [{ id, index }]
    // We track index to determine chronological order
    const readsByFile = new Map<string, { id: string; index: number }[]>()

    // Track successful write/edit file paths with their index
    const writesByFile = new Map<string, number[]>()

    for (let i = 0; i < allToolIds.length; i++) {
        const id = allToolIds[i]
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
        if (filePaths.length === 0) {
            continue
        }
        const filePath = filePaths[0]

        if (isFilePathProtected(filePaths, config.protectedFilePatterns)) {
            continue
        }

        if (metadata.tool === "read") {
            if (!readsByFile.has(filePath)) {
                readsByFile.set(filePath, [])
            }
            const reads = readsByFile.get(filePath)
            if (reads) {
                reads.push({ id, index: i })
            }
        } else if (
            (metadata.tool === "write" || metadata.tool === "edit") &&
            metadata.status === "completed"
        ) {
            if (!writesByFile.has(filePath)) {
                writesByFile.set(filePath, [])
            }
            const writes = writesByFile.get(filePath)
            if (writes) {
                writes.push(i)
            }
        }
    }

    // Find reads that are superseded by subsequent writes/edits
    const newPruneIds: string[] = []

    for (const [filePath, reads] of readsByFile.entries()) {
        const writes = writesByFile.get(filePath)
        if (!writes || writes.length === 0) {
            continue
        }

        // For each read, check if there's a write that comes after it
        for (const read of reads) {
            // Skip if already pruned
            if (state.prune.tools.has(read.id)) {
                continue
            }

            // Check if any write comes after this read
            const hasSubsequentWrite = writes.some((writeIndex) => writeIndex > read.index)
            if (hasSubsequentWrite) {
                newPruneIds.push(read.id)
            }
        }
    }

    if (newPruneIds.length > 0) {
        state.stats.totalPruneTokens += getTotalToolTokens(state, newPruneIds)
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            state.prune.tools.set(id, entry?.tokenCount ?? 0)
        }
        logger.debug(`Marked ${newPruneIds.length} superseded read tool calls for pruning`)
    }
}
