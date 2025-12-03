import type { Logger } from "../logger"
import type { PruningStrategy } from "../config"
import type { PluginState } from "../state"
import { estimateTokensBatch, formatTokenCount } from "../tokenizer"
import { saveSessionState } from "../state/persistence"
import { ensureSessionRestored } from "../state"
import {
    sendUnifiedNotification,
    type NotificationContext
} from "../ui/notification"

export interface SessionStats {
    totalToolsPruned: number
    totalTokensSaved: number
    totalGCTokens: number
    totalGCTools: number
}

export interface GCStats {
    tokensCollected: number
    toolsDeduped: number
}

export interface PruningResult {
    prunedCount: number
    tokensSaved: number
    llmPrunedIds: string[]
    toolMetadata: Map<string, { tool: string, parameters?: any }>
    sessionStats: SessionStats
}

export interface PruningOptions {
    reason?: string
    trigger: 'idle' | 'tool'
}

export interface JanitorConfig {
    protectedTools: string[]
    model?: string
    showModelErrorToasts: boolean
    strictModelSelection: boolean
    pruningSummary: "off" | "minimal" | "detailed"
    workingDirectory?: string
}

export interface JanitorContext {
    client: any
    state: PluginState
    logger: Logger
    config: JanitorConfig
    notificationCtx: NotificationContext
}

// ============================================================================
// Context factory
// ============================================================================

export function createJanitorContext(
    client: any,
    state: PluginState,
    logger: Logger,
    config: JanitorConfig
): JanitorContext {
    return {
        client,
        state,
        logger,
        config,
        notificationCtx: {
            client,
            logger,
            config: {
                pruningSummary: config.pruningSummary,
                workingDirectory: config.workingDirectory
            }
        }
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run pruning on idle trigger.
 * Note: onTool pruning is now handled directly by pruning-tool.ts
 */
export async function runOnIdle(
    ctx: JanitorContext,
    sessionID: string,
    strategies: PruningStrategy[]
): Promise<PruningResult | null> {
    return runWithStrategies(ctx, sessionID, strategies, { trigger: 'idle' })
}

// ============================================================================
// Core pruning logic (for onIdle only)
// ============================================================================

async function runWithStrategies(
    ctx: JanitorContext,
    sessionID: string,
    strategies: PruningStrategy[],
    options: PruningOptions
): Promise<PruningResult | null> {
    const { client, state, logger, config } = ctx

    try {
        if (strategies.length === 0) {
            return null
        }

        // Ensure persisted state is restored before processing
        await ensureSessionRestored(state, sessionID, logger)

        const [sessionInfoResponse, messagesResponse] = await Promise.all([
            client.session.get({ path: { id: sessionID } }),
            client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
        ])

        const sessionInfo = sessionInfoResponse.data
        const messages = messagesResponse.data || messagesResponse

        if (!messages || messages.length < 3) {
            return null
        }

        const currentAgent = findCurrentAgent(messages)
        const { toolCallIds, toolOutputs, toolMetadata } = parseMessages(messages, state.toolParameters)

        const alreadyPrunedIds = state.prunedIds.get(sessionID) ?? []
        const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

        const gcPending = state.gcPending.get(sessionID) ?? null

        if (unprunedToolCallIds.length === 0 && !gcPending) {
            return null
        }

        const candidateCount = unprunedToolCallIds.filter(id => {
            const metadata = toolMetadata.get(id)
            return !metadata || !config.protectedTools.includes(metadata.tool)
        }).length

        // For onIdle, we currently don't have AI analysis implemented
        // This is a placeholder for future idle pruning strategies
        const llmPrunedIds: string[] = []

        const finalNewlyPrunedIds = llmPrunedIds.filter(id => !alreadyPrunedIds.includes(id))

        if (finalNewlyPrunedIds.length === 0 && !gcPending) {
            return null
        }

        // Calculate stats & send notification
        const tokensSaved = await calculateTokensSaved(finalNewlyPrunedIds, toolOutputs)

        const currentStats = state.stats.get(sessionID) ?? {
            totalToolsPruned: 0,
            totalTokensSaved: 0,
            totalGCTokens: 0,
            totalGCTools: 0
        }

        const sessionStats: SessionStats = {
            totalToolsPruned: currentStats.totalToolsPruned + finalNewlyPrunedIds.length,
            totalTokensSaved: currentStats.totalTokensSaved + tokensSaved,
            totalGCTokens: currentStats.totalGCTokens + (gcPending?.tokensCollected ?? 0),
            totalGCTools: currentStats.totalGCTools + (gcPending?.toolsDeduped ?? 0)
        }
        state.stats.set(sessionID, sessionStats)

        const notificationSent = await sendUnifiedNotification(
            ctx.notificationCtx,
            sessionID,
            {
                aiPrunedCount: llmPrunedIds.length,
                aiTokensSaved: tokensSaved,
                aiPrunedIds: llmPrunedIds,
                toolMetadata,
                gcPending,
                sessionStats
            },
            currentAgent
        )

        if (gcPending) {
            state.gcPending.delete(sessionID)
        }

        if (finalNewlyPrunedIds.length === 0) {
            if (notificationSent) {
                logger.info("janitor", `GC-only notification: ~${formatTokenCount(gcPending?.tokensCollected ?? 0)} tokens from ${gcPending?.toolsDeduped ?? 0} deduped tools`, {
                    trigger: options.trigger
                })
            }
            return null
        }

        // State update (only if something was pruned)
        const allPrunedIds = [...new Set([...alreadyPrunedIds, ...llmPrunedIds])]
        state.prunedIds.set(sessionID, allPrunedIds)

        const sessionName = sessionInfo?.title
        saveSessionState(sessionID, new Set(allPrunedIds), sessionStats, logger, sessionName).catch(err => {
            logger.error("janitor", "Failed to persist state", { error: err.message })
        })

        const prunedCount = finalNewlyPrunedIds.length
        const keptCount = candidateCount - prunedCount

        const logMeta: Record<string, any> = { trigger: options.trigger }
        if (options.reason) {
            logMeta.reason = options.reason
        }
        if (gcPending) {
            logMeta.gcTokens = gcPending.tokensCollected
            logMeta.gcTools = gcPending.toolsDeduped
        }

        logger.info("janitor", `Pruned ${prunedCount}/${candidateCount} tools, ${keptCount} kept (~${formatTokenCount(tokensSaved)} tokens)`, logMeta)

        return {
            prunedCount: finalNewlyPrunedIds.length,
            tokensSaved,
            llmPrunedIds,
            toolMetadata,
            sessionStats
        }

    } catch (error: any) {
        ctx.logger.error("janitor", "Analysis failed", {
            error: error.message,
            trigger: options.trigger
        })
        return null
    }
}

// ============================================================================
// Message parsing
// ============================================================================

interface ParsedMessages {
    toolCallIds: string[]
    toolOutputs: Map<string, string>
    toolMetadata: Map<string, { tool: string, parameters?: any }>
}

export function parseMessages(
    messages: any[],
    toolParametersCache: Map<string, any>
): ParsedMessages {
    const toolCallIds: string[] = []
    const toolOutputs = new Map<string, string>()
    const toolMetadata = new Map<string, { tool: string, parameters?: any }>()

    for (const msg of messages) {
        if (msg.parts) {
            for (const part of msg.parts) {
                if (part.type === "tool" && part.callID) {
                    const normalizedId = part.callID.toLowerCase()
                    toolCallIds.push(normalizedId)

                    const cachedData = toolParametersCache.get(part.callID) || toolParametersCache.get(normalizedId)
                    const parameters = cachedData?.parameters ?? part.state?.input ?? part.parameters

                    toolMetadata.set(normalizedId, {
                        tool: part.tool,
                        parameters: parameters
                    })

                    if (part.state?.status === "completed" && part.state.output) {
                        toolOutputs.set(normalizedId, part.state.output)
                    }
                }
            }
        }
    }

    return { toolCallIds, toolOutputs, toolMetadata }
}

function findCurrentAgent(messages: any[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const info = msg.info
        if (info?.role === 'user') {
            return info.agent || 'build'
        }
    }
    return undefined
}

// ============================================================================
// Helpers
// ============================================================================

async function calculateTokensSaved(prunedIds: string[], toolOutputs: Map<string, string>): Promise<number> {
    const outputsToTokenize: string[] = []

    for (const prunedId of prunedIds) {
        const normalizedId = prunedId.toLowerCase()
        const output = toolOutputs.get(normalizedId)
        if (output) {
            outputsToTokenize.push(output)
        }
    }

    if (outputsToTokenize.length > 0) {
        const tokenCounts = await estimateTokensBatch(outputsToTokenize)
        return tokenCounts.reduce((sum, count) => sum + count, 0)
    }

    return 0
}
