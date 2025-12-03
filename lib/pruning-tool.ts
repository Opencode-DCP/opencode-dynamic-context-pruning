import { tool } from "@opencode-ai/plugin"
import type { PluginState } from "./state"
import type { PluginConfig } from "./config"
import type { ToolTracker } from "./api-formats/synth-instruction"
import { resetToolTrackerCount } from "./api-formats/synth-instruction"
import { isSubagentSession } from "./hooks"
import { getActualId } from "./state/id-mapping"
import { formatPruningResultForTool, sendUnifiedNotification, type NotificationContext } from "./ui/notification"
import { ensureSessionRestored } from "./state"
import { saveSessionState } from "./state/persistence"
import type { Logger } from "./logger"
import { estimateTokensBatch } from "./tokenizer"
import type { SessionStats } from "./core/janitor"
import { loadPrompt } from "./core/prompt"

/** Tool description loaded from prompts/tool.txt */
const TOOL_DESCRIPTION = loadPrompt("tool")

export interface PruneToolContext {
    client: any
    state: PluginState
    logger: Logger
    config: PluginConfig
    notificationCtx: NotificationContext
    workingDirectory?: string
}

/**
 * Creates the prune tool definition.
 * Accepts numeric IDs from the <prunable-tools> list and prunes those tool outputs.
 */
export function createPruningTool(
    ctx: PruneToolContext,
    toolTracker: ToolTracker
): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: {
            ids: tool.schema.array(tool.schema.number()).describe(
                "Array of numeric IDs to prune from the <prunable-tools> list"
            ),
        },
        async execute(args, toolCtx) {
            const { client, state, logger, config, notificationCtx, workingDirectory } = ctx
            const sessionId = toolCtx.sessionID

            // Skip pruning in subagent sessions
            if (await isSubagentSession(client, sessionId)) {
                return "Pruning is unavailable in subagent sessions. Do not call this tool again. Continue with your current task."
            }

            // Validate input
            if (!args.ids || args.ids.length === 0) {
                return "No IDs provided. Check the <prunable-tools> list for available IDs to prune."
            }

            // Restore persisted state if needed
            await ensureSessionRestored(state, sessionId, logger)

            // Convert numeric IDs to actual tool call IDs
            const prunedIds = args.ids
                .map(numId => getActualId(sessionId, numId))
                .filter((id): id is string => id !== undefined)

            logger.debug("prune-tool", "ID conversion", {
                inputIds: args.ids,
                actualIds: prunedIds,
                toolParamsKeys: Array.from(state.toolParameters.keys()).slice(0, 10)
            })

            if (prunedIds.length === 0) {
                return "None of the provided IDs were valid. Check the <prunable-tools> list for available IDs."
            }

            // Calculate tokens saved
            const tokensSaved = await calculateTokensSaved(client, sessionId, prunedIds, state)

            // Update stats
            const currentStats = state.stats.get(sessionId) ?? {
                totalToolsPruned: 0,
                totalTokensSaved: 0,
                totalGCTokens: 0,
                totalGCTools: 0
            }
            const sessionStats: SessionStats = {
                ...currentStats,
                totalToolsPruned: currentStats.totalToolsPruned + prunedIds.length,
                totalTokensSaved: currentStats.totalTokensSaved + tokensSaved
            }
            state.stats.set(sessionId, sessionStats)

            // Update pruned IDs state
            const alreadyPrunedIds = state.prunedIds.get(sessionId) ?? []
            const allPrunedIds = [...alreadyPrunedIds, ...prunedIds]
            state.prunedIds.set(sessionId, allPrunedIds)

            // Persist state
            saveSessionState(sessionId, new Set(allPrunedIds), sessionStats, logger)
                .catch(err => logger.error("prune-tool", "Failed to persist state", { error: err.message }))

            // Build tool metadata for notification
            // Keys are normalized to lowercase to match lookup in notification.ts
            const toolMetadata = new Map<string, { tool: string, parameters?: any }>()
            for (const id of prunedIds) {
                // Try both original and lowercase since caching may vary
                const meta = state.toolParameters.get(id) || state.toolParameters.get(id.toLowerCase())
                if (meta) {
                    toolMetadata.set(id.toLowerCase(), meta)
                } else {
                    logger.debug("prune-tool", "No metadata found for ID", {
                        id,
                        idLower: id.toLowerCase(),
                        hasOriginal: state.toolParameters.has(id),
                        hasLower: state.toolParameters.has(id.toLowerCase())
                    })
                }
            }

            // Send notification to user
            await sendUnifiedNotification(notificationCtx, sessionId, {
                aiPrunedCount: prunedIds.length,
                aiTokensSaved: tokensSaved,
                aiPrunedIds: prunedIds,
                toolMetadata,
                gcPending: null,
                sessionStats
            })

            // Skip next idle pruning since we just pruned
            toolTracker.skipNextIdle = true

            // Reset nudge counter
            if (config.nudge_freq > 0) {
                resetToolTrackerCount(toolTracker)
            }

            // Format result for the AI
            const result = {
                prunedCount: prunedIds.length,
                tokensSaved,
                llmPrunedIds: prunedIds,
                toolMetadata,
                sessionStats
            }

            const postPruneGuidance = "\n\nYou have already distilled relevant understanding in writing before calling this tool. Do not re-narrate; continue with your next task."

            return formatPruningResultForTool(result, workingDirectory) + postPruneGuidance
        },
    })
}

/**
 * Calculates approximate tokens saved by pruning the given tool call IDs.
 */
async function calculateTokensSaved(
    client: any,
    sessionId: string,
    prunedIds: string[],
    state: PluginState
): Promise<number> {
    try {
        // Fetch session messages to get tool output content
        const messagesResponse = await client.session.messages({
            path: { id: sessionId },
            query: { limit: 200 }
        })
        const messages = messagesResponse.data || messagesResponse

        // Build map of tool call ID -> output content
        const toolOutputs = new Map<string, string>()
        for (const msg of messages) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                const content = typeof msg.content === 'string'
                    ? msg.content
                    : JSON.stringify(msg.content)
                toolOutputs.set(msg.tool_call_id.toLowerCase(), content)
            }
            // Handle Anthropic format
            if (msg.role === 'user' && Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'tool_result' && part.tool_use_id) {
                        const content = typeof part.content === 'string'
                            ? part.content
                            : JSON.stringify(part.content)
                        toolOutputs.set(part.tool_use_id.toLowerCase(), content)
                    }
                }
            }
        }

        // Collect content for pruned outputs
        const contents: string[] = []
        for (const id of prunedIds) {
            const content = toolOutputs.get(id.toLowerCase())
            if (content) {
                contents.push(content)
            }
        }

        if (contents.length === 0) {
            return prunedIds.length * 500 // fallback estimate
        }

        // Estimate tokens
        const tokenCounts = await estimateTokensBatch(contents)
        return tokenCounts.reduce((sum, count) => sum + count, 0)
    } catch (error: any) {
        // If we can't calculate, estimate based on average
        return prunedIds.length * 500
    }
}
