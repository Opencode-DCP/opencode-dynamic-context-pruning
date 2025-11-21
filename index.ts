// index.ts - Main plugin entry point for Dynamic Context Pruning
import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { StateManager } from "./lib/state"
import { Janitor } from "./lib/janitor"
import { join } from "path"
import { homedir } from "os"

/**
 * Checks if a session is a subagent (child session)
 * Subagent sessions should skip pruning operations
 */
async function isSubagentSession(
    client: any,
    sessionID: string,
    logger: Logger
): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        
        if (result.data?.parentID) {
            logger.debug("subagent-check", "Detected subagent session, skipping pruning", {
                sessionID,
                parentID: result.data.parentID
            })
            return true
        }
        
        return false
    } catch (error: any) {
        logger.error("subagent-check", "Failed to check if session is subagent", {
            sessionID,
            error: error.message
        })
        // On error, assume it's not a subagent and continue (fail open)
        return false
    }
}

const plugin: Plugin = (async (ctx) => {
    const config = getConfig()

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
    const stateManager = new StateManager()
    const toolParametersCache = new Map<string, any>() // callID -> parameters
    const modelCache = new Map<string, { providerID: string; modelID: string }>() // sessionID -> model info
    const janitor = new Janitor(ctx.client, stateManager, logger, toolParametersCache, config.protectedTools, modelCache, config.model)

    const cacheToolParameters = (messages: any[], component: string) => {
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
                    logger.debug(component, "Cached tool parameters", {
                        callID: toolCall.id,
                        tool: toolCall.function.name,
                        hasParams: !!params
                    })
                } catch (error) {
                    // Ignore JSON parse errors for individual tool calls
                }
            }
        }
    }

    // Global fetch wrapper that caches tool parameters for janitor metadata
    // Note: Pruning is handled per-session in the chat.params hook, not here
    // This works because all providers ultimately call globalThis.fetch
    const originalGlobalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
        if (init?.body && typeof init.body === 'string') {
            try {
                const body = JSON.parse(init.body)
                if (body.messages && Array.isArray(body.messages)) {
                    // Cache tool parameters for janitor metadata
                    cacheToolParameters(body.messages, "global-fetch")
                    
                    // Log tool messages for debugging
                    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')
                    if (toolMessages.length > 0) {
                        logger.debug("global-fetch", "Found tool messages in request", {
                            toolMessageCount: toolMessages.length,
                            toolCallIds: toolMessages.map((m: any) => m.tool_call_id).slice(0, 5)
                        })
                    }
                }
            } catch (e) {
                // Ignore parse errors and fall through to original fetch
            }
        }

        return originalGlobalFetch(input, init)
    }

    logger.info("plugin", "Dynamic Context Pruning plugin initialized", {
        enabled: config.enabled,
        debug: config.debug,
        protectedTools: config.protectedTools,
        model: config.model,
        configFile: join(homedir(), ".config", "opencode", "dcp.jsonc"),
        logDirectory: join(homedir(), ".config", "opencode", "logs", "dcp"),
        globalFetchWrapped: true
    })

    return {
        /**
         * Event Hook: Triggers janitor analysis when session becomes idle
         */
        event: async ({ event }) => {
            if (event.type === "session.status" && event.properties.status.type === "idle") {
                // Skip pruning for subagent sessions
                if (await isSubagentSession(ctx.client, event.properties.sessionID, logger)) return

                logger.debug("event", "Session became idle, triggering janitor", {
                    sessionID: event.properties.sessionID
                })

                // Fire and forget the janitor - don't block the event handler
                janitor.run(event.properties.sessionID).catch(err => {
                    logger.error("event", "Janitor failed", {
                        sessionID: event.properties.sessionID,
                        error: err.message,
                        stack: err.stack
                    })
                })
            }
        },

        /**
         * Chat Params Hook: Wraps fetch function to filter pruned tool responses
         */
        "chat.params": async (input, output) => {
            const sessionId = input.sessionID

            // Debug: Log the entire input structure to see what we're getting
            logger.debug("chat.params", "Hook input structure", {
                sessionID: sessionId,
                hasProvider: !!input.provider,
                hasModel: !!input.model,
                providerKeys: input.provider ? Object.keys(input.provider) : [],
                provider: input.provider,
                modelKeys: input.model ? Object.keys(input.model) : [],
                model: input.model
            })

            // Cache model information for this session so janitor can access it
            // The provider.id is actually nested at provider.info.id (not in SDK types)
            let providerID = (input.provider as any)?.info?.id || input.provider?.id
            const modelID = input.model?.id
            
            // If provider.id is not available, try to get it from the message
            if (!providerID && input.message?.model?.providerID) {
                providerID = input.message.model.providerID
                logger.debug("chat.params", "Got providerID from message instead of provider object", {
                    sessionID: sessionId,
                    providerID: providerID
                })
            }
            
            if (providerID && modelID) {
                modelCache.set(sessionId, {
                    providerID: providerID,
                    modelID: modelID
                })
                logger.debug("chat.params", "Cached model info for session", {
                    sessionID: sessionId,
                    providerID: providerID,
                    modelID: modelID
                })
            } else {
                logger.warn("chat.params", "Missing provider or model info in hook input", {
                    sessionID: sessionId,
                    hasProvider: !!input.provider,
                    hasModel: !!input.model,
                    providerID: providerID,
                    modelID: modelID,
                    inputKeys: Object.keys(input),
                    messageModel: input.message?.model
                })
            }

            // Skip pruning for subagent sessions
            if (await isSubagentSession(ctx.client, sessionId, logger)) return

            logger.debug("chat.params", "Wrapping fetch for session", {
                sessionID: sessionId,
                hasFetch: !!output.options["fetch"],
                fetchType: output.options["fetch"] ? typeof output.options["fetch"] : "none"
            })

            // Get the existing fetch - this might be from auth provider or globalThis
            const existingFetch = output.options["fetch"] ?? globalThis.fetch

            logger.debug("chat.params", "Existing fetch captured", {
                sessionID: sessionId,
                isGlobalFetch: existingFetch === globalThis.fetch
            })

            // Wrap the existing fetch with our pruning logic
            output.options["fetch"] = async (fetchInput: any, init?: any) => {
                logger.info("pruning-fetch", "🔥 FETCH WRAPPER CALLED!", {
                    sessionId,
                    url: typeof fetchInput === 'string' ? fetchInput.substring(0, 100) : 'URL object'
                })
                logger.debug("pruning-fetch", "Request intercepted", { sessionId })

                // Retrieve the list of pruned tool call IDs from state
                const prunedIds = await stateManager.get(sessionId)
                logger.debug("pruning-fetch", "Retrieved pruned IDs", {
                    sessionId,
                    prunedCount: prunedIds.length,
                    prunedIds: prunedIds.length > 0 ? prunedIds : undefined
                })

                // Parse the request body once if possible for logging, caching, and filtering
                let parsedBody: any | undefined
                if (init?.body && typeof init.body === 'string') {
                    try {
                        parsedBody = JSON.parse(init.body)
                    } catch (e) {
                        // Ignore parse errors; we'll skip caching/filtering in this case
                    }
                }

                if (parsedBody?.messages) {
                    const toolMessages = parsedBody.messages.filter((m: any) => m.role === 'tool') || []
                    logger.debug("pruning-fetch", "Request body before filtering", {
                        sessionId,
                        totalMessages: parsedBody.messages.length,
                        toolMessages: toolMessages.length,
                        toolCallIds: toolMessages.map((m: any) => m.tool_call_id)
                    })

                    // Capture tool call parameters from assistant messages so Janitor toast metadata stays rich
                    cacheToolParameters(parsedBody.messages, "pruning-fetch")
                }

                // Reset the count for this request
                let prunedThisRequest = 0

                // Only attempt filtering if there are pruned IDs and a request body exists
                if (prunedIds.length > 0 && init?.body) {
                    let body = parsedBody

                    if (!body && typeof init.body === 'string') {
                        try {
                            body = JSON.parse(init.body)
                        } catch (error: any) {
                            logger.error("pruning-fetch", "Failed to parse/filter request body", {
                                sessionId,
                                error: error.message,
                                stack: error.stack
                            })
                            return existingFetch(fetchInput, init)
                        }
                    }

                    if (body?.messages && Array.isArray(body.messages)) {
                        const originalMessageCount = body.messages.length

                        // Replace tool response messages whose tool_call_id is in the pruned list
                        // with a short placeholder message instead of removing them entirely.
                        // This preserves the message structure and avoids API validation errors.
                        body.messages = body.messages.map((m: any) => {
                            if (m.role === 'tool' && prunedIds.includes(m.tool_call_id)) {
                                prunedThisRequest++
                                return {
                                    ...m,
                                    content: '[Output removed to save context - information superseded or no longer needed]'
                                }
                            }
                            return m
                        })

                        if (prunedThisRequest > 0) {
                            logger.info("pruning-fetch", "Replaced pruned tool messages", {
                                sessionId,
                                totalMessages: originalMessageCount,
                                replacedCount: prunedThisRequest,
                                prunedIds
                            })

                            // Log remaining tool messages
                            const remainingToolMessages = body.messages.filter((m: any) => m.role === 'tool')
                            logger.debug("pruning-fetch", "Tool messages after replacement", {
                                sessionId,
                                totalToolCount: remainingToolMessages.length,
                                toolCallIds: remainingToolMessages.map((m: any) => m.tool_call_id)
                            })

                            // Update the request body with modified messages
                            init.body = JSON.stringify(body)
                            parsedBody = body
                        } else {
                            logger.debug("pruning-fetch", "No messages replaced", {
                                sessionId,
                                messageCount: originalMessageCount
                            })
                        }
                    }
                }

                // Call the EXISTING fetch (which might be from auth provider) with potentially modified body
                return existingFetch(fetchInput, init)
            }
        },
    }
}) satisfies Plugin

export default plugin
