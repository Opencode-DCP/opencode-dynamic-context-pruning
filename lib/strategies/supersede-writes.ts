import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { getFilePathsFromParameters, isProtected } from "../protected-file-patterns"
import { calculateTokensSaved } from "./utils"

/**
 * Supersede Writes strategy - prunes write tool inputs for files that have
 * subsequently been read. When a file is written and later read, the original
 * write content becomes redundant since the current file state is captured
 * in the read result.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const supersedeWrites = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (!config.strategies.supersedeWrites.enabled) {
        return
    }

    const allToolIds = state.toolIdList
    if (allToolIds.length === 0) {
        return
    }

    // Filter out IDs already pruned
    const unprunedIds = allToolIds.filter((id) => !state.prune.toolIds.has(id))
    if (unprunedIds.length === 0) {
        return
    }

    // Track write tools by file path: filePath -> [{ id, index }]
    // We track index to determine chronological order
    const writesByFile = new Map<string, { id: string; index: number }[]>()

    // Track read file paths with their index
    const readsByFile = new Map<string, number[]>()

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

        if (isProtected(filePaths, config.protectedFilePatterns)) {
            continue
        }

        if (metadata.tool === "write") {
            if (!writesByFile.has(filePath)) {
                writesByFile.set(filePath, [])
            }
            const writes = writesByFile.get(filePath)
            if (writes) {
                writes.push({ id, index: i })
            }
        } else if (metadata.tool === "read") {
            if (!readsByFile.has(filePath)) {
                readsByFile.set(filePath, [])
            }
            const reads = readsByFile.get(filePath)
            if (reads) {
                reads.push(i)
            }
        }
    }

    // Find writes that are superseded by subsequent reads
    const newPruneIds: string[] = []

    for (const [filePath, writes] of writesByFile.entries()) {
        const reads = readsByFile.get(filePath)
        if (!reads || reads.length === 0) {
            continue
        }

        // For each write, check if there's a read that comes after it
        for (const write of writes) {
            // Skip if already pruned
            if (state.prune.toolIds.has(write.id)) {
                continue
            }

            // Check if any read comes after this write
            const hasSubsequentRead = reads.some((readIndex) => readIndex > write.index)
            if (hasSubsequentRead) {
                newPruneIds.push(write.id)
            }
        }
    }

    if (newPruneIds.length > 0) {
        state.stats.totalPruneTokens += calculateTokensSaved(state, messages, newPruneIds)
        for (const id of newPruneIds) {
            state.prune.toolIds.add(id)
        }
        logger.debug(`Marked ${newPruneIds.length} superseded write tool calls for pruning`)
    }
}
