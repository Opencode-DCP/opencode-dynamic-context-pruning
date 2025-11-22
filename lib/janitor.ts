import { generateObject } from "ai"
import { z } from "zod"
import type { Logger } from "./logger"
import type { StateManager } from "./state"
import { buildAnalysisPrompt } from "./prompt"
import { selectModel, extractModelFromSession } from "./model-selector"

export class Janitor {
    constructor(
        private client: any,
        private stateManager: StateManager,
        private logger: Logger,
        private toolParametersCache: Map<string, any>,
        private protectedTools: string[],
        private modelCache: Map<string, { providerID: string; modelID: string }>,
        private configModel?: string, // Format: "provider/model"
        private showModelErrorToasts: boolean = true // Whether to show toast for model errors
    ) { }

    /**
     * Sends an ignored message to the session UI (user sees it, AI doesn't)
     */
    private async sendIgnoredMessage(sessionID: string, text: string) {
        try {
            await this.client.session.prompt({
                path: {
                    id: sessionID
                },
                body: {
                    noReply: true, // Don't wait for AI response
                    parts: [{
                        type: 'text',
                        text: text,
                        ignored: true
                    }]
                }
            })
            this.logger.debug("janitor", "Sent ignored message to session", {
                sessionID,
                textLength: text.length
            })
        } catch (error: any) {
            this.logger.error("janitor", "Failed to send ignored message", {
                sessionID,
                error: error.message
            })
            // Don't fail the operation if sending the message fails
        }
    }

    async run(sessionID: string) {
        this.logger.info("janitor", "Starting analysis", { sessionID })

        try {
            // Fetch session info and messages from OpenCode API
            this.logger.debug("janitor", "Fetching session info and messages", { sessionID })

            const [sessionInfoResponse, messagesResponse] = await Promise.all([
                this.client.session.get({ path: { id: sessionID } }),
                this.client.session.messages({ path: { id: sessionID }, query: { limit: 100 } })
            ])

            const sessionInfo = sessionInfoResponse.data
            // Handle the response format - it should be { data: Array<{info, parts}> } or just the array
            const messages = messagesResponse.data || messagesResponse

            this.logger.debug("janitor", "Retrieved messages", {
                sessionID,
                messageCount: messages.length
            })

            // If there are no messages or very few, skip analysis
            if (!messages || messages.length < 3) {
                this.logger.debug("janitor", "Too few messages to analyze, skipping", {
                    sessionID,
                    messageCount: messages?.length || 0
                })
                return
            }

            // Extract tool call IDs from the session and track their output sizes
            // Also track batch tool relationships and tool metadata
            const toolCallIds: string[] = []
            const toolOutputs = new Map<string, string>()
            const toolMetadata = new Map<string, { tool: string, parameters?: any }>() // callID -> {tool, parameters}
            const batchToolChildren = new Map<string, string[]>() // batchID -> [childIDs]
            let currentBatchId: string | null = null

            for (const msg of messages) {
                if (msg.parts) {
                    for (const part of msg.parts) {
                        if (part.type === "tool" && part.callID) {
                            // Normalize tool call IDs to lowercase for consistent comparison
                            const normalizedId = part.callID.toLowerCase()
                            toolCallIds.push(normalizedId)

                            // Try to get parameters from cache first, fall back to part.parameters
                            // Cache might have either case, so check both
                            const cachedData = this.toolParametersCache.get(part.callID) || this.toolParametersCache.get(normalizedId)
                            const parameters = cachedData?.parameters || part.parameters

                            // Track tool metadata (name and parameters)
                            toolMetadata.set(normalizedId, {
                                tool: part.tool,
                                parameters: parameters
                            })

                            // Debug: log what we're storing
                            if (normalizedId.startsWith('prt_') || part.tool === "read" || part.tool === "list") {
                                this.logger.debug("janitor", "Storing tool metadata", {
                                    sessionID,
                                    callID: normalizedId,
                                    tool: part.tool,
                                    hasParameters: !!parameters,
                                    hasCached: !!cachedData,
                                    parameters: parameters
                                })
                            }

                            // Track the output content for size calculation
                            if (part.state?.status === "completed" && part.state.output) {
                                toolOutputs.set(normalizedId, part.state.output)
                            }

                            // Check if this is a batch tool by looking at the tool name
                            if (part.tool === "batch") {
                                const batchId = normalizedId
                                currentBatchId = batchId
                                batchToolChildren.set(batchId, [])
                                this.logger.debug("janitor", "Found batch tool", {
                                    sessionID,
                                    batchID: currentBatchId
                                })
                            }
                            // If we're inside a batch and this is a prt_ (parallel) tool call, it's a child
                            else if (currentBatchId && normalizedId.startsWith('prt_')) {
                                const children = batchToolChildren.get(currentBatchId)!
                                children.push(normalizedId)
                                this.logger.debug("janitor", "Added child to batch tool", {
                                    sessionID,
                                    batchID: currentBatchId,
                                    childID: normalizedId,
                                    totalChildren: children.length
                                })
                            }
                            // If we hit a non-batch, non-prt_ tool, we're out of the batch
                            else if (currentBatchId && !normalizedId.startsWith('prt_')) {
                                this.logger.debug("janitor", "Batch tool ended", {
                                    sessionID,
                                    batchID: currentBatchId,
                                    totalChildren: batchToolChildren.get(currentBatchId)!.length
                                })
                                currentBatchId = null
                            }
                        }
                    }
                }
            }

            // Log summary of batch tools found
            if (batchToolChildren.size > 0) {
                this.logger.debug("janitor", "Batch tool summary", {
                    sessionID,
                    batchCount: batchToolChildren.size,
                    batches: Array.from(batchToolChildren.entries()).map(([id, children]) => ({
                        batchID: id,
                        childCount: children.length,
                        childIDs: children
                    }))
                })
            }

            // Get already pruned IDs to filter them out
            const alreadyPrunedIds = await this.stateManager.get(sessionID)
            const unprunedToolCallIds = toolCallIds.filter(id => !alreadyPrunedIds.includes(id))

            this.logger.debug("janitor", "Found tool calls in session", {
                sessionID,
                toolCallCount: toolCallIds.length,
                toolCallIds,
                alreadyPrunedCount: alreadyPrunedIds.length,
                alreadyPrunedIds: alreadyPrunedIds.slice(0, 5), // Show first 5 for brevity
                unprunedCount: unprunedToolCallIds.length
            })

            // Filter out protected tools from being considered for pruning
            const protectedToolCallIds: string[] = []
            const prunableToolCallIds = unprunedToolCallIds.filter(id => {
                const metadata = toolMetadata.get(id)
                if (metadata && this.protectedTools.includes(metadata.tool)) {
                    protectedToolCallIds.push(id)
                    return false
                }
                return true
            })

            if (protectedToolCallIds.length > 0) {
                this.logger.debug("janitor", "Protected tools excluded from pruning", {
                    sessionID,
                    protectedCount: protectedToolCallIds.length,
                    protectedTools: protectedToolCallIds.map(id => {
                        const metadata = toolMetadata.get(id)
                        return { id, tool: metadata?.tool }
                    })
                })
            }

            // If there are no unpruned tool calls, skip analysis
            if (prunableToolCallIds.length === 0) {
                this.logger.debug("janitor", "No prunable tool calls found, skipping analysis", {
                    sessionID,
                    protectedCount: protectedToolCallIds.length
                })
                return
            }

            // Select appropriate model with intelligent fallback
            // Try to get model from cache first, otherwise extractModelFromSession won't find it
            const cachedModelInfo = this.modelCache.get(sessionID)
            const sessionModelInfo = extractModelFromSession(sessionInfo, this.logger)
            const currentModelInfo = cachedModelInfo || sessionModelInfo

            if (cachedModelInfo) {
                this.logger.debug("janitor", "Using cached model info", {
                    sessionID,
                    providerID: cachedModelInfo.providerID,
                    modelID: cachedModelInfo.modelID
                })
            }

            const modelSelection = await selectModel(currentModelInfo, this.logger, this.configModel)

            this.logger.info("janitor", "Model selected for analysis", {
                sessionID,
                modelInfo: modelSelection.modelInfo,
                source: modelSelection.source,
                reason: modelSelection.reason
            })

            // Show toast if we had to fallback from a failed model
            if (modelSelection.failedModel && this.showModelErrorToasts) {
                try {
                    await this.client.tui.showToast({
                        body: {
                            title: "DCP: Model fallback",
                            message: `${modelSelection.failedModel.providerID}/${modelSelection.failedModel.modelID} failed\nUsing ${modelSelection.modelInfo.providerID}/${modelSelection.modelInfo.modelID}`,
                            variant: "info",
                            duration: 5000
                        }
                    })
                    this.logger.info("janitor", "Toast notification shown for model fallback", {
                        failedModel: modelSelection.failedModel,
                        selectedModel: modelSelection.modelInfo
                    })
                } catch (toastError: any) {
                    this.logger.error("janitor", "Failed to show toast notification", {
                        error: toastError.message
                    })
                    // Don't fail the whole operation if toast fails
                }
            } else if (modelSelection.failedModel && !this.showModelErrorToasts) {
                this.logger.info("janitor", "Model fallback occurred but toast disabled by config", {
                    failedModel: modelSelection.failedModel,
                    selectedModel: modelSelection.modelInfo
                })
            }

            // Log comprehensive stats before AI call
            this.logger.info("janitor", "Preparing AI analysis", {
                sessionID,
                totalToolCallsInSession: toolCallIds.length,
                alreadyPrunedCount: alreadyPrunedIds.length,
                protectedToolsCount: protectedToolCallIds.length,
                candidatesForPruning: prunableToolCallIds.length,
                candidateTools: prunableToolCallIds.map(id => {
                    const meta = toolMetadata.get(id)
                    return meta ? `${meta.tool}[${id.substring(0, 12)}...]` : id.substring(0, 12) + '...'
                }).slice(0, 10), // Show first 10 for brevity
                batchToolCount: batchToolChildren.size,
                batchDetails: Array.from(batchToolChildren.entries()).map(([batchId, children]) => ({
                    batchId: batchId.substring(0, 20) + '...',
                    childCount: children.length
                }))
            })

            this.logger.debug("janitor", "Starting shadow inference", { sessionID })

            // Analyze which tool calls are obsolete
            const result = await generateObject({
                model: modelSelection.model,
                schema: z.object({
                    pruned_tool_call_ids: z.array(z.string()),
                    reasoning: z.string(),
                }),
                prompt: buildAnalysisPrompt(prunableToolCallIds, messages, this.protectedTools)
            })

            // Expand batch tool IDs to include their children
            // Note: IDs are already normalized to lowercase when collected from messages
            const expandedPrunedIds = new Set<string>()
            for (const prunedId of result.object.pruned_tool_call_ids) {
                const normalizedId = prunedId.toLowerCase()
                expandedPrunedIds.add(normalizedId)

                // If this is a batch tool, add all its children
                const children = batchToolChildren.get(normalizedId)
                if (children) {
                    this.logger.debug("janitor", "Expanding batch tool to include children", {
                        sessionID,
                        batchID: normalizedId,
                        childCount: children.length,
                        childIDs: children
                    })
                    children.forEach(childId => expandedPrunedIds.add(childId))
                }
            }

            // Calculate which IDs are actually NEW (not already pruned)
            const newlyPrunedIds = Array.from(expandedPrunedIds).filter(id => !alreadyPrunedIds.includes(id))
            
            // finalPrunedIds includes everything (new + already pruned) for logging
            const finalPrunedIds = Array.from(expandedPrunedIds)

            this.logger.info("janitor", "Analysis complete", {
                sessionID,
                prunedCount: finalPrunedIds.length,
                originalPrunedCount: result.object.pruned_tool_call_ids.length,
                prunedIds: finalPrunedIds,
                reasoning: result.object.reasoning
            })

            this.logger.debug("janitor", "Pruning ID details", {
                sessionID,
                alreadyPrunedCount: alreadyPrunedIds.length,
                alreadyPrunedIds: alreadyPrunedIds,
                finalPrunedCount: finalPrunedIds.length,
                finalPrunedIds: finalPrunedIds,
                newlyPrunedCount: newlyPrunedIds.length,
                newlyPrunedIds: newlyPrunedIds
            })

            // Calculate approximate size saved from newly pruned tool outputs
            let totalCharsSaved = 0
            for (const prunedId of newlyPrunedIds) {
                const output = toolOutputs.get(prunedId)
                if (output) {
                    totalCharsSaved += output.length
                }
            }

            // Rough token estimate (1 token ≈ 4 characters for English text)
            const estimatedTokensSaved = Math.round(totalCharsSaved / 4)

            // Merge newly pruned IDs with existing ones (using expanded IDs)
            const allPrunedIds = [...new Set([...alreadyPrunedIds, ...finalPrunedIds])]
            await this.stateManager.set(sessionID, allPrunedIds)
            this.logger.debug("janitor", "Updated state manager", {
                sessionID,
                totalPrunedCount: allPrunedIds.length,
                newlyPrunedCount: newlyPrunedIds.length
            })

            // Show toast notification if we pruned anything NEW
            if (newlyPrunedIds.length > 0) {
                try {
                    // Helper function to shorten paths for display
                    const shortenPath = (path: string): string => {
                        // Replace home directory with ~
                        const homeDir = require('os').homedir()
                        if (path.startsWith(homeDir)) {
                            path = '~' + path.slice(homeDir.length)
                        }

                        // Shorten node_modules paths: show package + file only
                        const nodeModulesMatch = path.match(/node_modules\/(@[^\/]+\/[^\/]+|[^\/]+)\/(.*)/)
                        if (nodeModulesMatch) {
                            return `${nodeModulesMatch[1]}/${nodeModulesMatch[2]}`
                        }

                        return path
                    }

                    // Helper function to truncate long strings
                    const truncate = (str: string, maxLen: number = 60): string => {
                        if (str.length <= maxLen) return str
                        return str.slice(0, maxLen - 3) + '...'
                    }

                    // Build a summary of pruned tools by grouping them
                    const toolsSummary = new Map<string, string[]>() // tool name -> [parameters]

                    for (const prunedId of newlyPrunedIds) {
                        const metadata = toolMetadata.get(prunedId)
                        if (metadata) {
                            const toolName = metadata.tool
                            if (!toolsSummary.has(toolName)) {
                                toolsSummary.set(toolName, [])
                            }

                            this.logger.debug("janitor", "Processing pruned tool metadata", {
                                sessionID,
                                prunedId,
                                toolName,
                                parameters: metadata.parameters
                            })

                            // Extract meaningful parameter info based on tool type
                            let paramInfo = ""
                            if (metadata.parameters) {
                                // For read tool, show filePath
                                if (toolName === "read" && metadata.parameters.filePath) {
                                    paramInfo = truncate(shortenPath(metadata.parameters.filePath), 80)
                                }
                                // For list tool, show path
                                else if (toolName === "list" && metadata.parameters.path) {
                                    paramInfo = truncate(shortenPath(metadata.parameters.path), 80)
                                }
                                // For bash/command tools, prefer description over command
                                else if (toolName === "bash") {
                                    if (metadata.parameters.description) {
                                        paramInfo = truncate(metadata.parameters.description, 80)
                                    } else if (metadata.parameters.command) {
                                        paramInfo = truncate(metadata.parameters.command, 80)
                                    }
                                }
                                // For other tools, show the first relevant parameter
                                else if (metadata.parameters.path) {
                                    paramInfo = truncate(shortenPath(metadata.parameters.path), 80)
                                }
                                else if (metadata.parameters.pattern) {
                                    paramInfo = truncate(metadata.parameters.pattern, 80)
                                }
                                else if (metadata.parameters.command) {
                                    paramInfo = truncate(metadata.parameters.command, 80)
                                }
                            }

                            if (paramInfo) {
                                toolsSummary.get(toolName)!.push(paramInfo)
                            }
                        } else {
                            this.logger.warn("janitor", "No metadata found for pruned tool", {
                                sessionID,
                                prunedId
                            })
                        }
                    }

                    // Format the message with tool details using improved UI
                    const toolText = newlyPrunedIds.length === 1 ? 'tool' : 'tools';
                    const tokensFormatted = estimatedTokensSaved >= 1000 
                        ? `~${Math.round(estimatedTokensSaved / 1000)}K` 
                        : `~${estimatedTokensSaved}`
                    
                    let message = `🧹 DCP: Saved ${tokensFormatted} tokens (${newlyPrunedIds.length} ${toolText} pruned)\n`

                    for (const [toolName, params] of toolsSummary.entries()) {
                        if (params.length > 0) {
                            message += `\n${toolName} (${params.length}):\n`
                            for (const param of params) {
                                message += `  ${param}\n`
                            }
                        } else {
                            // For tools with no specific params (like batch), just show the tool name and count
                            const count = newlyPrunedIds.filter(id => {
                                const m = toolMetadata.get(id)
                                return m && m.tool === toolName
                            }).length
                            if (count > 0) {
                                message += `\n${toolName} (${count})\n`
                            }
                        }
                    }

                    // Send as an ignored message (user sees, AI doesn't)
                    await this.sendIgnoredMessage(sessionID, message.trim())

                    this.logger.info("janitor", "Pruning notification sent", {
                        sessionID,
                        prunedCount: newlyPrunedIds.length,
                        estimatedTokensSaved,
                        totalCharsSaved,
                        toolsSummary: Array.from(toolsSummary.entries())
                    })
                } catch (toastError: any) {
                    this.logger.error("janitor", "Failed to show toast notification", {
                        sessionID,
                        error: toastError.message
                    })
                    // Don't fail the whole pruning operation if toast fails
                }
            }

        } catch (error: any) {
            this.logger.error("janitor", "Analysis failed", {
                sessionID,
                error: error.message,
                stack: error.stack
            })
            // Don't throw - this is a fire-and-forget background process
            // Silently fail and try again on next idle event
        }
    }
}
