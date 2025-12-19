import { tool } from "@opencode-ai/plugin"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { buildToolIdList } from "../messages/utils"
import { PruneReason, sendUnifiedNotification } from "../ui/notification"
import { formatPruningResultForTool } from "../ui/utils"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompt"
import { calculateTokensSaved, getCurrentParams } from "./utils"

/** Tool description loaded from prompts/prune-tool-spec.txt */
const TOOL_DESCRIPTION = loadPrompt("prune-tool-spec")

export interface PruneToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}

/**
 * Creates the prune tool definition.
 * Accepts numeric IDs from the <prunable-tools> list and prunes those tool outputs.
 */
export function createPruneTool(
    ctx: PruneToolContext,
): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: {
            ids: tool.schema.array(
                tool.schema.string()
            ).describe(
                "First element is the reason ('completion', 'noise', 'consolidation'), followed by numeric IDs as strings to prune"
            ),
            distillation: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe(
                "An object containing detailed summaries or extractions of the key findings from the tools being pruned. This is REQUIRED for 'consolidation'."
            ),
        },
        async execute(args, toolCtx) {
            const { client, state, logger, config, workingDirectory } = ctx
            const sessionId = toolCtx.sessionID

            logger.info("Prune tool invoked")
            logger.info(JSON.stringify(args))

            if (!args.ids || args.ids.length === 0) {
                logger.debug("Prune tool called but args.ids is empty or undefined: " + JSON.stringify(args))
                return "No IDs provided. Check the <prunable-tools> list for available IDs to prune."
            }

            // Parse reason from first element, numeric IDs from the rest

            const reason = args.ids[0];
            const validReasons = ["completion", "noise", "consolidation"] as const
            if (typeof reason !== "string" || !validReasons.includes(reason as any)) {
                logger.debug("Invalid pruning reason provided: " + reason)
                return "No valid pruning reason found. Use 'completion', 'noise', or 'consolidation' as the first element."
            }

            const numericToolIds: number[] = args.ids.slice(1)
                .map(id => parseInt(id, 10))
                .filter((n): n is number => !isNaN(n))

            // Extract distillation if present in the IDs array (packed as an object or long string)
            // or if we add a dedicated non-primitive argument.
            // For now, let's keep the schema simple and use the logic that Objects don't show in TUI.
            const distillation = (args as any).distillation;
            if (numericToolIds.length === 0) {
                logger.debug("No numeric tool IDs provided for pruning, yet prune tool was called: " + JSON.stringify(args))
                return "No numeric IDs provided. Format: [reason, id1, id2, ...] where reason is 'completion', 'noise', or 'consolidation'."
            }

            // Fetch messages to calculate tokens and find current agent
            const messagesResponse = await client.session.messages({
                path: { id: sessionId }
            })
            const messages: WithParts[] = messagesResponse.data || messagesResponse

            await ensureSessionInitialized(ctx.client, state, sessionId, logger, messages)

            const currentParams = getCurrentParams(messages, logger)
            const toolIdList: string[] = buildToolIdList(state, messages, logger)

            // Validate that all numeric IDs are within bounds
            if (numericToolIds.some(id => id < 0 || id >= toolIdList.length)) {
                logger.debug("Invalid tool IDs provided: " + numericToolIds.join(", "))
                return "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list."
            }

            // Validate that all IDs exist in cache and aren't protected
            // (rejects hallucinated IDs and turn-protected tools not shown in <prunable-tools>)
            for (const index of numericToolIds) {
                const id = toolIdList[index]
                const metadata = state.toolParameters.get(id)
                if (!metadata) {
                    logger.debug("Rejecting prune request - ID not in cache (turn-protected or hallucinated)", { index, id })
                    return "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list."
                }
                if (config.strategies.pruneTool.protectedTools.includes(metadata.tool)) {
                    logger.debug("Rejecting prune request - protected tool", { index, id, tool: metadata.tool })
                    return "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list."
                }
            }

            const pruneToolIds: string[] = numericToolIds.map(index => toolIdList[index])
            state.prune.toolIds.push(...pruneToolIds)

            const toolMetadata = new Map<string, ToolParameterEntry>()
            for (const id of pruneToolIds) {
                const toolParameters = state.toolParameters.get(id)
                if (toolParameters) {
                    toolMetadata.set(id, toolParameters)
                } else {
                    logger.debug("No metadata found for ID", { id })
                }
            }

            state.stats.pruneTokenCounter += calculateTokensSaved(state, messages, pruneToolIds)

            await sendUnifiedNotification(
                client,
                logger,
                config,
                state,
                sessionId,
                pruneToolIds,
                toolMetadata,
                reason as PruneReason,
                currentParams,
                workingDirectory
            )

            state.stats.totalPruneTokens += state.stats.pruneTokenCounter
            state.stats.pruneTokenCounter = 0
            state.nudgeCounter = 0

            saveSessionState(state, logger)
                .catch(err => logger.error("Failed to persist state", { error: err.message }))

            const result = formatPruningResultForTool(
                pruneToolIds,
                toolMetadata,
                workingDirectory
            )

            if (distillation) {
                logger.info("Distillation data received:", distillation)
            }

            return result
        },
    })
}

