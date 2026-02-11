import { tool } from "@opencode-ai/plugin"
import type { WithParts, CompressSummary } from "../state"
import type { ToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { loadPrompt } from "../prompts"
import { getCurrentParams, getTotalToolTokens, countMessageTextTokens } from "../strategies/utils"
import { findStringInMessages, collectToolIdsInRange, collectMessageIdsInRange } from "./utils"
import { annotateContext, COMPRESS_SUMMARY_PREFIX } from "../messages/utils"
import { sendCompressNotification } from "../ui/notification"
import { prune as applyPruneTransforms } from "../messages/prune"
import { clog, C } from "../compress-logger"

const COMPRESS_TOOL_DESCRIPTION = loadPrompt("compress-tool-spec")

function resolveSummaryAnchorMessageId(
    messageId: string,
    transformedMessages: WithParts[],
    summaries: CompressSummary[],
): string | undefined {
    const message = transformedMessages.find((item) => item.info.id === messageId)
    if (!message) {
        return undefined
    }

    const textPart = message.parts.find((part) => part.type === "text")
    if (!textPart || textPart.type !== "text") {
        return undefined
    }

    if (!textPart.text.includes(COMPRESS_SUMMARY_PREFIX)) {
        return undefined
    }

    const summary = summaries.find((item) => textPart.text.includes(item.summary))
    if (!summary) {
        return undefined
    }

    return summary.anchorMessageId
}

export function createCompressTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: COMPRESS_TOOL_DESCRIPTION,
        args: {
            topic: tool.schema
                .string()
                .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
            content: tool.schema
                .object({
                    startString: tool.schema
                        .string()
                        .describe(
                            "Unique text marking range start. Prefer exact `[muid_x]` or `[uid_x]` anchors over prose.",
                        ),
                    endString: tool.schema
                        .string()
                        .describe(
                            "Unique text marking range end. Prefer exact `[muid_x]` or `[uid_x]` anchors over prose.",
                        ),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                })
                .describe("Compression details: boundaries and replacement summary"),
        },
        async execute(args, toolCtx) {
            const invocationId = Date.now().toString(36)
            clog.info(C.COMPRESS, `=== COMPRESS INVOCATION START [${invocationId}] ===`)

            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const { topic, content } = args
            const { startString, endString, summary } = content || {}

            clog.info(C.COMPRESS, `[${invocationId}] Args received`, {
                topic,
                startString: startString?.substring(0, 120),
                startStringLen: startString?.length,
                endString: endString?.substring(0, 120),
                endStringLen: endString?.length,
                summaryLen: summary?.length,
            })

            if (!topic || typeof topic !== "string") {
                clog.error(C.COMPRESS, `[${invocationId}] FAILED: topic missing or not string`, {
                    topic,
                })
                throw new Error("topic is required and must be a non-empty string")
            }
            if (!startString || typeof startString !== "string") {
                clog.error(
                    C.COMPRESS,
                    `[${invocationId}] FAILED: startString missing or not string`,
                    { startString: typeof startString },
                )
                throw new Error("content.startString is required and must be a non-empty string")
            }
            if (!endString || typeof endString !== "string") {
                clog.error(
                    C.COMPRESS,
                    `[${invocationId}] FAILED: endString missing or not string`,
                    { endString: typeof endString },
                )
                throw new Error("content.endString is required and must be a non-empty string")
            }
            if (!summary || typeof summary !== "string") {
                clog.error(C.COMPRESS, `[${invocationId}] FAILED: summary missing or not string`, {
                    summary: typeof summary,
                })
                throw new Error("content.summary is required and must be a non-empty string")
            }

            const { client, state, logger } = ctx
            const sessionId = toolCtx.sessionID

            clog.info(C.COMPRESS, `[${invocationId}] Session=${sessionId}`)

            try {
                const messagesResponse = await client.session.messages({
                    path: { id: sessionId },
                })
                const messages: WithParts[] = messagesResponse.data || messagesResponse

                clog.info(C.COMPRESS, `[${invocationId}] Fetched ${messages.length} raw messages`)

                await ensureSessionInitialized(
                    client,
                    state,
                    sessionId,
                    logger,
                    messages,
                    ctx.config.manualMode.enabled,
                )

                clog.info(C.STATE, `[${invocationId}] State snapshot before boundary matching`, {
                    sessionId: state.sessionId,
                    isSubAgent: state.isSubAgent,
                    compressSummariesCount: state.compressSummaries.length,
                    pruneToolsSize: state.prune.tools.size,
                    pruneMessagesSize: state.prune.messages.size,
                    toolParametersSize: state.toolParameters.size,
                    currentTurn: state.currentTurn,
                    nudgeCounter: state.nudgeCounter,
                })

                const transformedMessages = structuredClone(messages) as WithParts[]
                applyPruneTransforms(state, logger, ctx.config, transformedMessages)
                annotateContext(transformedMessages)

                clog.info(
                    C.COMPRESS,
                    `[${invocationId}] After prune+annotate: ${transformedMessages.length} transformed messages (from ${messages.length} raw)`,
                )

                // Log message IDs for both raw and transformed to detect discrepancies
                clog.debug(C.COMPRESS, `[${invocationId}] Raw message IDs`, {
                    ids: messages.map((m, i) => `${i}:${m.info.id}:${m.info.role}`),
                })
                clog.debug(C.COMPRESS, `[${invocationId}] Transformed message IDs`, {
                    ids: transformedMessages.map((m, i) => `${i}:${m.info.id}:${m.info.role}`),
                })

                clog.info(C.BOUNDARY, `[${invocationId}] Searching for startString...`)
                const startResult = findStringInMessages(
                    transformedMessages,
                    startString,
                    "startString",
                )
                clog.info(C.BOUNDARY, `[${invocationId}] startString found`, {
                    messageId: startResult.messageId,
                    messageIndex: startResult.messageIndex,
                })

                clog.info(C.BOUNDARY, `[${invocationId}] Searching for endString...`)
                const endResult = findStringInMessages(transformedMessages, endString, "endString")
                clog.info(C.BOUNDARY, `[${invocationId}] endString found`, {
                    messageId: endResult.messageId,
                    messageIndex: endResult.messageIndex,
                })

                let rawStartIndex = messages.findIndex((m) => m.info.id === startResult.messageId)
                let rawEndIndex = messages.findIndex((m) => m.info.id === endResult.messageId)

                clog.info(C.COMPRESS, `[${invocationId}] Raw index mapping (direct)`, {
                    startMsgId: startResult.messageId,
                    rawStartIndex,
                    endMsgId: endResult.messageId,
                    rawEndIndex,
                })

                // If a boundary matched inside a synthetic compress summary message,
                // resolve it back to the summary's anchor message in the raw messages
                if (rawStartIndex === -1) {
                    clog.warn(
                        C.COMPRESS,
                        `[${invocationId}] startString messageId not found in raw, trying compressSummaries fallback`,
                        {
                            messageId: startResult.messageId,
                            summariesCount: state.compressSummaries.length,
                        },
                    )

                    const syntheticAnchorMessageId = resolveSummaryAnchorMessageId(
                        startResult.messageId,
                        transformedMessages,
                        state.compressSummaries,
                    )
                    if (syntheticAnchorMessageId) {
                        rawStartIndex = messages.findIndex(
                            (m) => m.info.id === syntheticAnchorMessageId,
                        )
                        clog.info(
                            C.COMPRESS,
                            `[${invocationId}] startString resolved from synthetic summary message`,
                            {
                                syntheticMessageId: startResult.messageId,
                                anchorMessageId: syntheticAnchorMessageId,
                                rawStartIndex,
                            },
                        )
                    }

                    if (rawStartIndex === -1) {
                        const summary = state.compressSummaries.find((s) =>
                            s.summary.includes(startString),
                        )
                        if (summary) {
                            rawStartIndex = messages.findIndex(
                                (m) => m.info.id === summary.anchorMessageId,
                            )
                            clog.info(
                                C.COMPRESS,
                                `[${invocationId}] startString resolved via summary anchor`,
                                {
                                    anchorMessageId: summary.anchorMessageId,
                                    rawStartIndex,
                                },
                            )
                        } else {
                            clog.error(
                                C.COMPRESS,
                                `[${invocationId}] startString not found in any compressSummary either`,
                            )
                        }
                    }
                }
                if (rawEndIndex === -1) {
                    clog.warn(
                        C.COMPRESS,
                        `[${invocationId}] endString messageId not found in raw, trying compressSummaries fallback`,
                        {
                            messageId: endResult.messageId,
                            summariesCount: state.compressSummaries.length,
                        },
                    )

                    const syntheticAnchorMessageId = resolveSummaryAnchorMessageId(
                        endResult.messageId,
                        transformedMessages,
                        state.compressSummaries,
                    )
                    if (syntheticAnchorMessageId) {
                        rawEndIndex = messages.findIndex(
                            (m) => m.info.id === syntheticAnchorMessageId,
                        )
                        clog.info(
                            C.COMPRESS,
                            `[${invocationId}] endString resolved from synthetic summary message`,
                            {
                                syntheticMessageId: endResult.messageId,
                                anchorMessageId: syntheticAnchorMessageId,
                                rawEndIndex,
                            },
                        )
                    }

                    if (rawEndIndex === -1) {
                        const summary = state.compressSummaries.find((s) =>
                            s.summary.includes(endString),
                        )
                        if (summary) {
                            rawEndIndex = messages.findIndex(
                                (m) => m.info.id === summary.anchorMessageId,
                            )
                            clog.info(
                                C.COMPRESS,
                                `[${invocationId}] endString resolved via summary anchor`,
                                {
                                    anchorMessageId: summary.anchorMessageId,
                                    rawEndIndex,
                                },
                            )
                        } else {
                            clog.error(
                                C.COMPRESS,
                                `[${invocationId}] endString not found in any compressSummary either`,
                            )
                        }
                    }
                }

                if (rawStartIndex === -1 || rawEndIndex === -1) {
                    clog.error(
                        C.COMPRESS,
                        `[${invocationId}] FAILED: Cannot map boundaries to raw messages`,
                        {
                            rawStartIndex,
                            rawEndIndex,
                            startMsgId: startResult.messageId,
                            endMsgId: endResult.messageId,
                            rawMessageIds: messages.map((m) => m.info.id),
                            transformedMessageIds: transformedMessages.map((m) => m.info.id),
                            compressSummaries: state.compressSummaries.map((s) => ({
                                anchor: s.anchorMessageId,
                                summaryPreview: s.summary.substring(0, 80),
                            })),
                        },
                    )
                    throw new Error(`Failed to map boundary matches back to raw messages`)
                }

                if (rawStartIndex > rawEndIndex) {
                    clog.error(
                        C.COMPRESS,
                        `[${invocationId}] FAILED: startString after endString`,
                        {
                            rawStartIndex,
                            rawEndIndex,
                            startMsgId: startResult.messageId,
                            endMsgId: endResult.messageId,
                        },
                    )
                    throw new Error(
                        "startString appears after endString in the conversation. Start must come before end.",
                    )
                }

                clog.info(
                    C.COMPRESS,
                    `[${invocationId}] Final raw range: [${rawStartIndex}..${rawEndIndex}] (${rawEndIndex - rawStartIndex + 1} messages)`,
                )

                const containedToolIds = collectToolIdsInRange(messages, rawStartIndex, rawEndIndex)
                const containedMessageIds = collectMessageIdsInRange(
                    messages,
                    rawStartIndex,
                    rawEndIndex,
                )

                clog.info(C.COMPRESS, `[${invocationId}] Range contents`, {
                    toolIds: containedToolIds.length,
                    messageIds: containedMessageIds.length,
                    toolIdsSample: containedToolIds.slice(0, 5),
                    messageIdsSample: containedMessageIds.slice(0, 5),
                })

                // Remove any existing summaries whose anchors are now inside this range
                // This prevents duplicate injections when a larger compress subsumes a smaller one
                const removedSummaries = state.compressSummaries.filter((s) =>
                    containedMessageIds.includes(s.anchorMessageId),
                )
                if (removedSummaries.length > 0) {
                    clog.info(
                        C.COMPRESS,
                        `[${invocationId}] Removing ${removedSummaries.length} subsumed summaries`,
                        {
                            removed: removedSummaries.map((s) => ({
                                anchor: s.anchorMessageId,
                                preview: s.summary.substring(0, 60),
                            })),
                        },
                    )
                    state.compressSummaries = state.compressSummaries.filter(
                        (s) => !containedMessageIds.includes(s.anchorMessageId),
                    )
                }

                const anchorMessageId = messages[rawStartIndex]?.info.id || startResult.messageId
                const compressSummary: CompressSummary = {
                    anchorMessageId,
                    summary,
                }
                state.compressSummaries.push(compressSummary)

                clog.info(
                    C.COMPRESS,
                    `[${invocationId}] New summary anchored at ${anchorMessageId}, total summaries: ${state.compressSummaries.length}`,
                )

                const compressedMessageIds = containedMessageIds.filter(
                    (id) => !state.prune.messages.has(id),
                )
                const compressedToolIds = containedToolIds.filter(
                    (id) => !state.prune.tools.has(id),
                )

                clog.info(
                    C.COMPRESS,
                    `[${invocationId}] New items to prune (excluding already pruned)`,
                    {
                        newMessages: compressedMessageIds.length,
                        newTools: compressedToolIds.length,
                        alreadyPrunedMessages:
                            containedMessageIds.length - compressedMessageIds.length,
                        alreadyPrunedTools: containedToolIds.length - compressedToolIds.length,
                    },
                )

                let textTokens = 0
                for (const msgId of compressedMessageIds) {
                    const msg = messages.find((m) => m.info.id === msgId)
                    if (msg) {
                        const tokens = countMessageTextTokens(msg)
                        textTokens += tokens
                        state.prune.messages.set(msgId, tokens)
                    }
                }
                const toolTokens = getTotalToolTokens(state, compressedToolIds)
                for (const id of compressedToolIds) {
                    const entry = state.toolParameters.get(id)
                    state.prune.tools.set(id, entry?.tokenCount ?? 0)
                }
                const estimatedCompressedTokens = textTokens + toolTokens

                clog.info(C.COMPRESS, `[${invocationId}] Token accounting`, {
                    textTokens,
                    toolTokens,
                    estimatedCompressedTokens,
                    pruneToolsSizeAfter: state.prune.tools.size,
                    pruneMessagesSizeAfter: state.prune.messages.size,
                })

                state.stats.pruneTokenCounter += estimatedCompressedTokens

                const rawStartResult = { messageId: anchorMessageId, messageIndex: rawStartIndex }
                const rawEndMessageId = messages[rawEndIndex]?.info.id || endResult.messageId
                const rawEndResult = { messageId: rawEndMessageId, messageIndex: rawEndIndex }

                const currentParams = getCurrentParams(state, messages, logger)
                await sendCompressNotification(
                    client,
                    logger,
                    ctx.config,
                    state,
                    sessionId,
                    compressedToolIds,
                    compressedMessageIds,
                    topic,
                    summary,
                    rawStartResult,
                    rawEndResult,
                    messages.length,
                    currentParams,
                )

                state.stats.totalPruneTokens += state.stats.pruneTokenCounter
                state.stats.pruneTokenCounter = 0
                state.nudgeCounter = 0

                clog.info(C.COMPRESS, `[${invocationId}] Final stats`, {
                    totalPruneTokens: state.stats.totalPruneTokens,
                    nudgeCounter: state.nudgeCounter,
                })

                saveSessionState(state, logger).catch((err) => {
                    clog.error(C.STATE, `[${invocationId}] Failed to persist session state`, {
                        error: err.message,
                    })
                })

                const result = `Compressed ${compressedMessageIds.length} messages (${compressedToolIds.length} tool calls) into summary. The content will be replaced with your summary.`
                clog.info(
                    C.COMPRESS,
                    `=== COMPRESS INVOCATION SUCCESS [${invocationId}] === ${result}`,
                )
                void clog.flush()

                return result
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                const stack = err instanceof Error ? err.stack : undefined
                clog.error(C.COMPRESS, `=== COMPRESS INVOCATION FAILED [${invocationId}] ===`, {
                    error: msg,
                    stack,
                    topic,
                    startString: startString.substring(0, 120),
                    endString: endString.substring(0, 120),
                })
                void clog.flush()
                throw err
            }
        },
    })
}
