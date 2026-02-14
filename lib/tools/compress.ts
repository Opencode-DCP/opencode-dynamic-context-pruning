import { tool } from "@opencode-ai/plugin"
import type { WithParts, CompressSummary } from "../state"
import type { ToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { COMPRESS_TOOL_SPEC } from "../prompts"
import { getCurrentParams, countAllMessageTokens, countTokens } from "../strategies/utils"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import {
    findStringInMessages,
    collectToolIdsInRange,
    collectMessageIdsInRange,
    findSummaryAnchorForBoundary,
} from "./utils"
import { sendCompressNotification } from "../ui/notification"
import { prune as applyPruneTransforms } from "../messages/prune"
import { clog, C } from "../compress-logger"

const COMPRESS_TOOL_DESCRIPTION = COMPRESS_TOOL_SPEC
const COMPRESS_SUMMARY_PREFIX = "[Compressed conversation block]\n\n"
const SUMMARY_PLACEHOLDER_REGEX = /\{summary_(\d+)\}/gi
const COMPRESS_RESULT_NAME_REGEX = /^<compress_result\s+name="([^"]+)"[^>]*>/i
const SUMMARY_NAME_REGEX = /^summary_(\d+)$/i

function stripSummaryPrefix(summary: string): string {
    if (summary.startsWith(COMPRESS_SUMMARY_PREFIX)) {
        return summary.slice(COMPRESS_SUMMARY_PREFIX.length).trim()
    }
    return summary.trim()
}

function wrapSummaryBlock(name: string, content: string): string {
    return `<compress_result name="${name}">\n${content.trim()}\n</compress_result>`
}

function getNextSummaryNumericId(summaries: CompressSummary[]): number {
    let maxId = -1

    for (const summary of summaries) {
        const content = stripSummaryPrefix(summary.summary)
        const matches = content.matchAll(/<compress_result\s+name="summary_(\d+)"[^>]*>/gi)
        for (const match of matches) {
            const value = Number.parseInt(match[1], 10)
            if (!Number.isNaN(value) && value > maxId) {
                maxId = value
            }
        }
    }

    return maxId + 1
}

interface NamedSummaryBlock {
    name: string
    block: string
}

function buildNamedSummaryBlocks(removedSummaries: CompressSummary[]): NamedSummaryBlock[] {
    const stripped = removedSummaries
        .map((s) => stripSummaryPrefix(s.summary))
        .filter((s) => s.length > 0)

    if (stripped.length === 0) {
        return []
    }

    const namesInUse = new Set<string>()
    for (const block of stripped) {
        const match = block.match(COMPRESS_RESULT_NAME_REGEX)
        const existingName = match?.[1]?.trim() || ""

        if (SUMMARY_NAME_REGEX.test(existingName)) {
            namesInUse.add(existingName.toLowerCase())
        }
    }

    const result: NamedSummaryBlock[] = []
    let fallbackId = 0
    const nextFallbackName = (): string => {
        while (namesInUse.has(`summary_${fallbackId}`)) {
            fallbackId++
        }
        const name = `summary_${fallbackId}`
        namesInUse.add(name)
        fallbackId++
        return name
    }

    for (const block of stripped) {
        const match = block.match(COMPRESS_RESULT_NAME_REGEX)
        const existingName = match?.[1]?.trim() || ""
        if (SUMMARY_NAME_REGEX.test(existingName)) {
            const normalizedName = existingName.toLowerCase()
            result.push({
                name: normalizedName,
                block,
            })
            continue
        }

        const fallbackName = nextFallbackName()
        result.push({
            name: fallbackName,
            block: wrapSummaryBlock(fallbackName, block),
        })
    }

    return result
}

export function mergeSubsumedSummaries(
    removedSummaries: CompressSummary[],
    newSummary: string,
    currentSummaryName: string,
): string {
    const namedSummaryBlocks = buildNamedSummaryBlocks(removedSummaries)

    if (namedSummaryBlocks.length === 0) {
        return newSummary
    }

    const summaryByName = new Map(namedSummaryBlocks.map((entry) => [entry.name, entry.block]))

    const usedSummaryNames = new Set<string>()

    const mergedByTag = newSummary.replace(
        SUMMARY_PLACEHOLDER_REGEX,
        (_fullTag, numericSuffix: string) => {
            const name = `summary_${numericSuffix}`.toLowerCase()
            const block = summaryByName.get(name)
            if (!block) {
                return ""
            }

            usedSummaryNames.add(name)
            return block
        },
    )

    const unresolvedSummaries = namedSummaryBlocks
        .filter((entry) => !usedSummaryNames.has(entry.name))
        .map((entry) => entry.block)

    const trimmedMerged = mergedByTag.trim()

    if (unresolvedSummaries.length === 0) {
        return trimmedMerged
    }

    const unresolvedCount = unresolvedSummaries.length
    const unresolvedHeader =
        unresolvedCount === 1
            ? `${currentSummaryName} overlapped 1 summary that was not included in the output. It has been appended below:`
            : `${currentSummaryName} overlapped ${unresolvedCount} summaries that were not included in the output. They have been appended below:`
    const unresolvedAppendix = `${unresolvedHeader}\n\n${unresolvedSummaries.join("\n\n")}`

    if (trimmedMerged.length === 0) {
        return unresolvedAppendix
    }

    return `${trimmedMerged}\n\n${unresolvedAppendix}`
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
                        .describe("Unique text from conversation marking the beginning of range"),
                    endString: tool.schema
                        .string()
                        .describe("Unique text marking the end of range"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                })
                .describe("Compression details: boundaries and replacement summary"),
        },
        async execute(args, toolCtx) {
            const invocationId = Date.now().toString(36)
            const separator = "═".repeat(79)
            clog.info(
                C.COMPRESS,
                `${separator}\nCOMPRESS INVOCATION START\nID: ${invocationId}\n${separator}`,
            )

            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const { topic, content } = args
            const { startString, endString, summary } = content || {}

            clog.info(C.COMPRESS, `Arguments`, {
                topic,
                startString: startString ? `"${startString.substring(0, 120)}"` : undefined,
                startStringLength: startString?.length,
                endString: endString ? `"${endString.substring(0, 120)}"` : undefined,
                endStringLength: endString?.length,
                summaryLength: summary?.length,
            })

            if (!topic || typeof topic !== "string") {
                clog.error(C.COMPRESS, `✗ Validation Failed\ntopic missing or not string`, {
                    topic,
                })
                throw new Error("topic is required and must be a non-empty string")
            }
            if (!startString || typeof startString !== "string") {
                clog.error(C.COMPRESS, `✗ Validation Failed\nstartString missing or not string`, {
                    startString: typeof startString,
                })
                throw new Error("content.startString is required and must be a non-empty string")
            }
            if (!endString || typeof endString !== "string") {
                clog.error(C.COMPRESS, `✗ Validation Failed\nendString missing or not string`, {
                    endString: typeof endString,
                })
                throw new Error("content.endString is required and must be a non-empty string")
            }
            if (!summary || typeof summary !== "string") {
                clog.error(C.COMPRESS, `✗ Validation Failed\nsummary missing or not string`, {
                    summary: typeof summary,
                })
                throw new Error("content.summary is required and must be a non-empty string")
            }

            const { client, state, logger } = ctx
            const sessionId = toolCtx.sessionID

            clog.info(C.COMPRESS, `Session\nid: ${sessionId}`)

            try {
                const messagesResponse = await client.session.messages({
                    path: { id: sessionId },
                })
                const messages: WithParts[] = messagesResponse.data || messagesResponse

                clog.info(C.COMPRESS, `Messages\nfetched: ${messages.length} raw messages`)

                await ensureSessionInitialized(
                    client,
                    state,
                    sessionId,
                    logger,
                    messages,
                    ctx.config.manualMode.enabled,
                )

                clog.info(C.STATE, `State Snapshot (before boundary matching)`, {
                    sessionId: state.sessionId,
                    isSubAgent: state.isSubAgent,
                    summaries: state.compressSummaries.length,
                    pruned: {
                        tools: state.prune.tools.size,
                        messages: state.prune.messages.size,
                    },
                    toolParameters: state.toolParameters.size,
                    turn: state.currentTurn,
                })

                const transformedMessages = structuredClone(messages) as WithParts[]
                applyPruneTransforms(state, logger, ctx.config, transformedMessages)

                clog.info(
                    C.COMPRESS,
                    `Prune Transform\nraw: ${messages.length} messages\ntransformed: ${transformedMessages.length} messages`,
                )

                // Log message IDs for both raw and transformed to detect discrepancies
                clog.debug(C.COMPRESS, `Message IDs`, {
                    raw: messages.map((m, i) => `${i}:${m.info.id}:${m.info.role}`),
                    transformed: transformedMessages.map(
                        (m, i) => `${i}:${m.info.id}:${m.info.role}`,
                    ),
                })

                clog.info(C.BOUNDARY, `Boundary Search: START STRING\nsearching...`)
                const startResult = findStringInMessages(
                    transformedMessages,
                    startString,
                    logger,
                    "startString",
                )
                clog.info(C.BOUNDARY, `✓ Start boundary found`, {
                    messageId: startResult.messageId,
                    messageIndex: startResult.messageIndex,
                })

                clog.info(C.BOUNDARY, `Boundary Search: END STRING\nsearching...`)
                const endResult = findStringInMessages(
                    transformedMessages,
                    endString,
                    logger,
                    "endString",
                )
                clog.info(C.BOUNDARY, `✓ End boundary found`, {
                    messageId: endResult.messageId,
                    messageIndex: endResult.messageIndex,
                })

                let rawStartIndex = messages.findIndex((m) => m.info.id === startResult.messageId)
                let rawEndIndex = messages.findIndex((m) => m.info.id === endResult.messageId)

                clog.info(C.COMPRESS, `Raw Index Mapping (direct)`, {
                    start: { messageId: startResult.messageId, rawIndex: rawStartIndex },
                    end: { messageId: endResult.messageId, rawIndex: rawEndIndex },
                })

                // If a boundary matched inside a synthetic compress summary message,
                // resolve it back to the summary's anchor message in the raw messages
                if (rawStartIndex === -1) {
                    clog.warn(
                        C.COMPRESS,
                        `⚠ Start boundary not in raw messages\nTrying compressSummaries fallback...`,
                        {
                            messageId: startResult.messageId,
                            summaries: state.compressSummaries.length,
                        },
                    )
                    const s = findSummaryAnchorForBoundary(
                        state.compressSummaries,
                        startString,
                        "startString",
                    )
                    if (s) {
                        rawStartIndex = messages.findIndex((m) => m.info.id === s.anchorMessageId)
                        clog.info(C.COMPRESS, `✓ Start resolved via summary anchor`, {
                            anchorMessageId: s.anchorMessageId,
                            rawStartIndex,
                        })
                    } else {
                        clog.warn(
                            C.COMPRESS,
                            `✗ Start not found in any summary either\nCannot resolve boundary`,
                        )
                    }
                }
                if (rawEndIndex === -1) {
                    clog.warn(
                        C.COMPRESS,
                        `⚠ End boundary not in raw messages\nTrying compressSummaries fallback...`,
                        {
                            messageId: endResult.messageId,
                            summaries: state.compressSummaries.length,
                        },
                    )
                    const s = findSummaryAnchorForBoundary(
                        state.compressSummaries,
                        endString,
                        "endString",
                    )
                    if (s) {
                        rawEndIndex = messages.findIndex((m) => m.info.id === s.anchorMessageId)
                        clog.info(C.COMPRESS, `✓ End resolved via summary anchor`, {
                            anchorMessageId: s.anchorMessageId,
                            rawEndIndex,
                        })
                    } else {
                        clog.warn(
                            C.COMPRESS,
                            `✗ End not found in any summary either\nCannot resolve boundary`,
                        )
                    }
                }

                if (rawStartIndex === -1 || rawEndIndex === -1) {
                    clog.error(
                        C.COMPRESS,
                        `✗ Boundary Mapping Failed\nCannot map boundaries to raw`,
                        {
                            indices: { rawStartIndex, rawEndIndex },
                            boundaries: {
                                start: startResult.messageId,
                                end: endResult.messageId,
                            },
                            context: {
                                rawMessageIds: messages.map((m) => m.info.id),
                                transformedMessageIds: transformedMessages.map((m) => m.info.id),
                                summaries: state.compressSummaries.map((s) => ({
                                    anchor: s.anchorMessageId,
                                    preview: s.summary.substring(0, 80),
                                })),
                            },
                        },
                    )
                    throw new Error(`Failed to map boundary matches back to raw messages`)
                }

                if (rawStartIndex > rawEndIndex) {
                    clog.error(C.COMPRESS, `✗ Invalid Range\nStart appears after end`, {
                        rawStartIndex,
                        rawEndIndex,
                        start: startResult.messageId,
                        end: endResult.messageId,
                    })
                    throw new Error(
                        "startString appears after endString in the conversation. Start must come before end.",
                    )
                }

                const rangeSize = rawEndIndex - rawStartIndex + 1
                clog.info(
                    C.COMPRESS,
                    `Final Range\n[${rawStartIndex}..${rawEndIndex}] → ${rangeSize} messages`,
                )

                const containedToolIds = collectToolIdsInRange(messages, rawStartIndex, rawEndIndex)
                const containedMessageIds = collectMessageIdsInRange(
                    messages,
                    rawStartIndex,
                    rawEndIndex,
                )

                clog.info(C.COMPRESS, `Range Contents`, {
                    tools: containedToolIds.length,
                    messages: containedMessageIds.length,
                    samples: {
                        toolIds: containedToolIds.slice(0, 5),
                        messageIds: containedMessageIds.slice(0, 5),
                    },
                })

                const nextSummaryNumericId = getNextSummaryNumericId(state.compressSummaries)
                const nextSummaryName = `summary_${nextSummaryNumericId}`

                // Remove any existing summaries whose anchors are now inside this range
                // This prevents duplicate injections when a larger compress subsumes a smaller one
                const removedSummaries = state.compressSummaries.filter((s) =>
                    containedMessageIds.includes(s.anchorMessageId),
                )
                if (removedSummaries.length > 0) {
                    clog.info(
                        C.COMPRESS,
                        `Merging Subsumed Summaries\ncount: ${removedSummaries.length}`,
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

                const mergedSummary = mergeSubsumedSummaries(
                    removedSummaries,
                    summary,
                    nextSummaryName,
                )
                const wrappedMergedSummary = wrapSummaryBlock(nextSummaryName, mergedSummary)

                const anchorMessageId = messages[rawStartIndex]?.info.id || startResult.messageId
                const compressSummary: CompressSummary = {
                    anchorMessageId,
                    summary: COMPRESS_SUMMARY_PREFIX + wrappedMergedSummary,
                }
                state.compressSummaries.push(compressSummary)

                clog.info(C.COMPRESS, `Summary Creation`, {
                    anchor: anchorMessageId,
                    summaryName: nextSummaryName,
                    totalSummaries: state.compressSummaries.length,
                })

                const compressedMessageIds = containedMessageIds.filter(
                    (id) => !state.prune.messages.has(id),
                )
                const compressedToolIds = containedToolIds.filter(
                    (id) => !state.prune.tools.has(id),
                )

                clog.info(C.COMPRESS, `Prune Accounting`, {
                    new: {
                        messages: compressedMessageIds.length,
                        tools: compressedToolIds.length,
                    },
                    alreadyPruned: {
                        messages: containedMessageIds.length - compressedMessageIds.length,
                        tools: containedToolIds.length - compressedToolIds.length,
                    },
                })

                let estimatedCompressedTokens = 0
                for (const msgId of compressedMessageIds) {
                    const msg = messages.find((m) => m.info.id === msgId)
                    if (msg) {
                        const tokens = countAllMessageTokens(msg)
                        estimatedCompressedTokens += tokens
                        state.prune.messages.set(msgId, tokens)
                    }
                }
                for (const id of compressedToolIds) {
                    const entry = state.toolParameters.get(id)
                    state.prune.tools.set(id, entry?.tokenCount ?? 0)
                }

                // Use API-reported tokens from last assistant message (matches OpenCode UI)
                let totalSessionTokens = 0
                let hasApiTokenMetadata = false
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].info.role === "assistant") {
                        const info = messages[i].info as AssistantMessage
                        const input = info.tokens?.input || 0
                        const output = info.tokens?.output || 0
                        const reasoning = info.tokens?.reasoning || 0
                        const cacheRead = info.tokens?.cache?.read || 0
                        const cacheWrite = info.tokens?.cache?.write || 0
                        const total = input + output + reasoning + cacheRead + cacheWrite
                        if (total > 0) {
                            totalSessionTokens = total
                            hasApiTokenMetadata = true
                            break
                        }
                    }
                }

                if (!hasApiTokenMetadata) {
                    let estimatedContentTokens = 0
                    for (const msg of messages) {
                        estimatedContentTokens += countAllMessageTokens(msg)
                    }
                    totalSessionTokens = estimatedContentTokens
                    clog.info(C.COMPRESS, `Token Accounting Fallback`, {
                        totalSessionTokens,
                    })
                }

                // Cap estimate — countAllMessageTokens can inflate beyond API count
                if (totalSessionTokens > 0 && estimatedCompressedTokens > totalSessionTokens) {
                    estimatedCompressedTokens = Math.round(totalSessionTokens * 0.95)
                }

                clog.info(C.COMPRESS, `Token Accounting`, {
                    totalSessionTokens,
                    estimatedCompressedTokens,
                    compressedMessages: compressedMessageIds.length,
                    compressedTools: compressedToolIds.length,
                    pruneState: {
                        tools: state.prune.tools.size,
                        messages: state.prune.messages.size,
                    },
                })

                state.stats.pruneTokenCounter += estimatedCompressedTokens

                const currentParams = getCurrentParams(state, messages, logger)
                const summaryTokens = countTokens(compressSummary.summary)

                clog.info(C.COMPRESS, `Notification Values`, {
                    totalSessionTokens,
                    estimatedCompressedTokens,
                    summaryTokens,
                    reductionPercent:
                        totalSessionTokens > 0
                            ? `-${Math.round((estimatedCompressedTokens / totalSessionTokens) * 100)}%`
                            : "N/A",
                    messageCount: messages.length,
                    compressedMessageIds: compressedMessageIds.length,
                    compressedToolIds: compressedToolIds.length,
                })

                await sendCompressNotification(
                    client,
                    logger,
                    ctx.config,
                    state,
                    sessionId,
                    compressedToolIds,
                    compressedMessageIds,
                    topic,
                    wrappedMergedSummary,
                    summaryTokens,
                    totalSessionTokens,
                    estimatedCompressedTokens,
                    messages.map((m) => m.info.id),
                    messages.length,
                    currentParams,
                )

                state.stats.totalPruneTokens += state.stats.pruneTokenCounter
                state.stats.pruneTokenCounter = 0
                state.contextLimitAnchors = new Set<string>()

                clog.info(C.COMPRESS, `Final Stats`, {
                    totalPruneTokens: state.stats.totalPruneTokens,
                })

                saveSessionState(state, logger).catch((err) => {
                    clog.error(C.STATE, `✗ State Persistence Failed`, { error: err.message })
                })

                const result = `Compressed ${compressedMessageIds.length} messages (${compressedToolIds.length} tool calls) into summary (${summaryTokens} tokens). The content will be replaced with your summary.`
                clog.info(
                    C.COMPRESS,
                    `${separator}\n✓ COMPRESS INVOCATION SUCCESS\nID: ${invocationId}\n\n${result}\n${separator}`,
                )
                void clog.flush()

                return result
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                const stack = err instanceof Error ? err.stack : undefined
                const separator = "═".repeat(79)
                clog.error(
                    C.COMPRESS,
                    `${separator}\n✗ COMPRESS INVOCATION FAILED\nID: ${invocationId}\n${separator}`,
                    {
                        error: msg,
                        stack,
                        context: {
                            topic,
                            startString: startString.substring(0, 120),
                            endString: endString.substring(0, 120),
                        },
                    },
                )
                void clog.flush()
                throw err
            }
        },
    })
}
