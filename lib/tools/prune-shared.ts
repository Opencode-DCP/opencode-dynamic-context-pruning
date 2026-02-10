import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { PruneToolContext } from "./types"
import { syncToolCache } from "../state/tool-cache"
import { PruneReason, sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { getTotalToolTokens, getCurrentParams } from "../strategies/utils"
import { getFilePathsFromParameters, isProtected } from "../protected-file-patterns"
import { buildToolIdList } from "../messages/utils"

// Shared logic for executing prune operations.
export async function executePruneOperation(
    ctx: PruneToolContext,
    toolCtx: { sessionID: string },
    ids: string[],
    reason: PruneReason,
    toolName: string,
    distillation?: string[],
): Promise<string> {
    const { client, state, logger, config, workingDirectory } = ctx
    const sessionId = toolCtx.sessionID

    logger.info(`${toolName} tool invoked`)
    logger.info(JSON.stringify(reason ? { ids, reason } : { ids }))

    if (!ids || ids.length === 0) {
        logger.debug(`${toolName} tool called but ids is empty or undefined`)
        throw new Error(
            `No IDs provided. Check the <prunable-tools> list for available IDs to ${toolName.toLowerCase()}.`,
        )
    }

    const numericToolIds: number[] = ids
        .map((id) => parseInt(id, 10))
        .filter((n): n is number => !isNaN(n))

    if (numericToolIds.length === 0) {
        logger.debug(`No numeric tool IDs provided for ${toolName}: ` + JSON.stringify(ids))
        throw new Error("No numeric IDs provided. Format: ids: [id1, id2, ...]")
    }

    // Fetch messages to calculate tokens and find current agent
    const messagesResponse = await client.session.messages({
        path: { id: sessionId },
    })
    const messages: WithParts[] = messagesResponse.data || messagesResponse

    // These 3 are probably not needed as they should always be set in the message
    // transform handler, but in case something causes state to reset, this is a safety net
    await ensureSessionInitialized(
        ctx.client,
        state,
        sessionId,
        logger,
        messages,
        config.manualMode.enabled,
    )
    syncToolCache(state, config, logger, messages)
    buildToolIdList(state, messages, logger)

    const currentParams = getCurrentParams(state, messages, logger)

    const toolIdList = state.toolIdList

    const validNumericIds: number[] = []
    const skippedIds: string[] = []

    // Validate and filter IDs
    for (const index of numericToolIds) {
        // Validate that index is within bounds
        if (index < 0 || index >= toolIdList.length) {
            logger.debug(`Rejecting prune request - index out of bounds: ${index}`)
            skippedIds.push(index.toString())
            continue
        }

        const id = toolIdList[index]
        const metadata = state.toolParameters.get(id)

        // Validate that all IDs exist in cache and aren't protected
        // (rejects hallucinated IDs and turn-protected tools not shown in <prunable-tools>)
        if (!metadata) {
            logger.debug(
                "Rejecting prune request - ID not in cache (turn-protected or hallucinated)",
                { index, id },
            )
            skippedIds.push(index.toString())
            continue
        }

        const allProtectedTools = config.tools.settings.protectedTools
        if (allProtectedTools.includes(metadata.tool)) {
            logger.debug("Rejecting prune request - protected tool", {
                index,
                id,
                tool: metadata.tool,
            })
            skippedIds.push(index.toString())
            continue
        }

        const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
        if (isProtected(filePaths, config.protectedFilePatterns)) {
            logger.debug("Rejecting prune request - protected file path", {
                index,
                id,
                tool: metadata.tool,
                filePaths,
            })
            skippedIds.push(index.toString())
            continue
        }

        validNumericIds.push(index)
    }

    if (validNumericIds.length === 0) {
        const errorMsg =
            skippedIds.length > 0
                ? `Invalid IDs provided: [${skippedIds.join(", ")}]. Only use numeric IDs from the <prunable-tools> list.`
                : `No valid IDs provided to ${toolName.toLowerCase()}.`
        throw new Error(errorMsg)
    }

    const pruneToolIds: string[] = validNumericIds.map((index) => toolIdList[index])
    for (const id of pruneToolIds) {
        const entry = state.toolParameters.get(id)
        state.prune.tools.set(id, entry?.tokenCount ?? 0)
    }

    const toolMetadata = new Map<string, ToolParameterEntry>()
    for (const id of pruneToolIds) {
        const toolParameters = state.toolParameters.get(id)
        if (toolParameters) {
            toolMetadata.set(id, toolParameters)
        } else {
            logger.debug("No metadata found for ID", { id })
        }
    }

    state.stats.pruneTokenCounter += getTotalToolTokens(state, pruneToolIds)

    await sendUnifiedNotification(
        client,
        logger,
        config,
        state,
        sessionId,
        pruneToolIds,
        toolMetadata,
        reason,
        currentParams,
        workingDirectory,
        distillation,
    )

    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    state.nudgeCounter = 0

    saveSessionState(state, logger).catch((err) =>
        logger.error("Failed to persist state", { error: err.message }),
    )

    let result = formatPruningResultForTool(pruneToolIds, toolMetadata, workingDirectory)
    if (skippedIds.length > 0) {
        result += `\n\nNote: ${skippedIds.length} IDs were skipped (invalid, protected, or missing metadata): ${skippedIds.join(", ")}`
    }
    return result
}
