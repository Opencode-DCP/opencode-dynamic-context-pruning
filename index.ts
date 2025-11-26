// index.ts - Main plugin entry point for Dynamic Context Pruning
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { Janitor, type SessionStats } from "./lib/janitor"
import { checkForUpdates } from "./lib/version-checker"

/**
 * Checks if a session is a subagent (child session)
 * Subagent sessions should skip pruning operations
 */
async function isSubagentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        // On error, assume it's not a subagent and continue (fail open)
        return false
    }
}

const plugin: Plugin = (async (ctx) => {
    const { config, migrations } = getConfig(ctx)

    // Exit early if plugin is disabled
    if (!config.enabled) {
        return {}
    }

    // Suppress AI SDK warnings about responseFormat (harmless for our use case)
    if (typeof globalThis !== 'undefined') {
        (globalThis as any).AI_SDK_LOG_WARNINGS = false
    }

    // Logger uses ~/.config/opencode/logs/dcp/ for consistent log location
    const logger = new Logger(config.debug)
    const prunedIdsState = new Map<string, string[]>()
    const statsState = new Map<string, SessionStats>()
    const toolParametersCache = new Map<string, any>() // callID -> parameters
    const modelCache = new Map<string, { providerID: string; modelID: string }>() // sessionID -> model info
    const janitor = new Janitor(ctx.client, prunedIdsState, statsState, logger, toolParametersCache, config.protectedTools, modelCache, config.model, config.showModelErrorToasts, config.pruning_summary, ctx.directory)

    const cacheToolParameters = (messages: any[]) => {
        for (const message of messages) {
            if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
                continue
            }

            for (const toolCall of message.tool_calls) {
                if (!toolCall.id || !toolCall.function) {
                    continue
                }

                try {
                    const params = typeof toolCall.function.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : toolCall.function.arguments
                    toolParametersCache.set(toolCall.id, {
                        tool: toolCall.function.name,
                        parameters: params
                    })
                } catch (error) {
                    // Ignore JSON parse errors for individual tool calls
                }
            }
        }
    }

    // Global fetch wrapper that both caches tool parameters AND performs pruning
    // This works because all providers ultimately call globalThis.fetch
    const originalGlobalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
        if (init?.body && typeof init.body === 'string') {
            try {
                const body = JSON.parse(init.body)
                if (body.messages && Array.isArray(body.messages)) {
                    // Cache tool parameters for janitor metadata
                    cacheToolParameters(body.messages)

                    // Check for tool messages that might need pruning
                    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')

                    // Collect all pruned IDs across all sessions (excluding subagents)
                    // This is safe because tool_call_ids are globally unique
                    const allSessions = await ctx.client.session.list()
                    const allPrunedIds = new Set<string>()

                    if (allSessions.data) {
                        for (const session of allSessions.data) {
                            if (session.parentID) continue // Skip subagent sessions
                            const prunedIds = prunedIdsState.get(session.id) ?? []
                            prunedIds.forEach((id: string) => allPrunedIds.add(id))
                        }
                    }

                    // Only process tool message replacement if there are tool messages and pruned IDs
                    if (toolMessages.length > 0 && allPrunedIds.size > 0) {
                        let replacedCount = 0

                        body.messages = body.messages.map((m: any) => {
                            // Normalize ID to lowercase for case-insensitive matching
                            if (m.role === 'tool' && allPrunedIds.has(m.tool_call_id?.toLowerCase())) {
                                replacedCount++
                                return {
                                    ...m,
                                    content: '[Output removed to save context - information superseded or no longer needed]'
                                }
                            }
                            return m
                        })

                        if (replacedCount > 0) {
                            logger.info("fetch", "Replaced pruned tool outputs", {
                                replaced: replacedCount,
                                total: toolMessages.length
                            })

                            // Save wrapped context to file if debug is enabled
                            if (logger.enabled) {
                                await logger.saveWrappedContext(
                                    "global",
                                    body.messages,
                                    {
                                        url: typeof input === 'string' ? input : 'URL object',
                                        replacedCount,
                                        totalMessages: body.messages.length
                                    }
                                )
                            }

                            // Update the request body with modified messages
                            init.body = JSON.stringify(body)
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors and fall through to original fetch
            }
        }

        return originalGlobalFetch(input, init)
    }

    logger.info("plugin", "DCP initialized", {
        strategies: config.strategies,
        model: config.model || "auto"
    })

    // Check for updates on launch (fire and forget)
    checkForUpdates(ctx.client, logger).catch(() => {})

    // Show migration toast if config was migrated (delayed to not overlap with version toast)
    if (migrations.length > 0) {
        setTimeout(async () => {
            try {
                await ctx.client.tui.showToast({
                    body: {
                        title: "DCP: Config upgraded",
                        message: migrations.join('\n'),
                        variant: "info",
                        duration: 8000
                    }
                })
            } catch {
                // Silently fail - toast is non-critical
            }
        }, 7000) // 7s delay to show after version toast (6s) completes
    }

    return {
        /**
         * Event Hook: Triggers janitor analysis when session becomes idle
         */
        event: async ({ event }) => {
            if (event.type === "session.status" && event.properties.status.type === "idle") {
                // Skip pruning for subagent sessions
                if (await isSubagentSession(ctx.client, event.properties.sessionID)) return

                // Skip if no idle strategies configured
                if (config.strategies.onIdle.length === 0) return

                // Fire and forget the janitor - don't block the event handler
                janitor.runOnIdle(event.properties.sessionID, config.strategies.onIdle).catch(err => {
                    logger.error("janitor", "Failed", { error: err.message })
                })
            }
        },

        /**
         * Chat Params Hook: Caches model info for janitor
         */
        "chat.params": async (input, _output) => {
            const sessionId = input.sessionID

            // Cache model information for this session so janitor can access it
            // The provider.id is actually nested at provider.info.id (not in SDK types)
            let providerID = (input.provider as any)?.info?.id || input.provider?.id
            const modelID = input.model?.id

            // If provider.id is not available, try to get it from the message
            if (!providerID && input.message?.model?.providerID) {
                providerID = input.message.model.providerID
            }

            if (providerID && modelID) {
                modelCache.set(sessionId, {
                    providerID: providerID,
                    modelID: modelID
                })
            }
        },

        /**
         * Tool Hook: Exposes context_pruning tool to AI (if configured)
         */
        tool: config.strategies.onTool.length > 0 ? {
            context_pruning: tool({
                description: `Performs semantic pruning on session tool outputs that are no longer relevant to the current task. Use this to declutter the conversation context and filter signal from noise when you notice the context is getting cluttered with outdated information.

## When to Use This Tool

- After completing a debugging session or fixing a bug
- When switching focus to a new task or feature
- After exploring multiple files that didn't lead to changes
- When you've been iterating on a difficult problem and some approaches didn't pan out
- When old file reads, greps, or bash outputs are no longer relevant

## Examples

<example>
Working through a list of bugs to fix:
User: Please fix these 5 type errors in the codebase.
Assistant: I'll work through each error. [Fixes first error]
First error fixed. Let me prune the debugging context before moving to the next one.
[Uses context_pruning with reason: "first bug fixed, moving to next task"]
</example>

<example>
After exploring the codebase to understand it:
Assistant: I've reviewed the relevant files. Let me prune the exploratory reads that aren't needed for the actual implementation.
[Uses context_pruning with reason: "exploration complete, pruning unrelated file reads"]
</example>

<example>
After trying multiple approaches that didn't work:
Assistant: I've been trying several approaches to fix this issue. Let me prune the failed attempts to keep focus on the working solution.
[Uses context_pruning with reason: "pruning failed iteration attempts, keeping working solution context"]
</example>`,
                args: {
                    reason: tool.schema.string().optional().describe(
                        "Brief reason for triggering pruning (e.g., 'task complete', 'switching focus')"
                    ),
                },
                async execute(args, ctx) {
                    const result = await janitor.runForTool(
                        ctx.sessionID,
                        config.strategies.onTool,
                        args.reason
                    )

                    if (!result || result.prunedCount === 0) {
                        return "No prunable tool outputs found. Context is already optimized."
                    }

                    return janitor.formatPruningResultForTool(result)
                },
            }),
        } : undefined,
    }
}) satisfies Plugin

export default plugin
