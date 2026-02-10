import { tool } from "@opencode-ai/plugin"
import type { WithParts, CompressSummary } from "../state"
import type { PruneToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { loadPrompt } from "../prompts"
import { getCurrentParams, getTotalToolTokens, countMessageTextTokens } from "../strategies/utils"
import { findStringInMessages, collectToolIdsInRange, collectMessageIdsInRange } from "./utils"
import { sendCompressNotification } from "../ui/notification"
import { prune as applyPruneTransforms } from "../messages/prune"

const COMPRESS_TOOL_DESCRIPTION = loadPrompt("compress-tool-spec")

export function createCompressTool(ctx: PruneToolContext): ReturnType<typeof tool> {
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
                .describe("The compression details: boundaries and replacement summary"),
        },
        async execute(args, toolCtx) {
            const { client, state, logger } = ctx
            const sessionId = toolCtx.sessionID

            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const { topic, content } = args
            const { startString, endString, summary } = content || {}

            if (!topic || typeof topic !== "string") {
                throw new Error("topic is required and must be a non-empty string")
            }
            if (!startString || typeof startString !== "string") {
                throw new Error("content.startString is required and must be a non-empty string")
            }
            if (!endString || typeof endString !== "string") {
                throw new Error("content.endString is required and must be a non-empty string")
            }
            if (!summary || typeof summary !== "string") {
                throw new Error("content.summary is required and must be a non-empty string")
            }

            // logger.info("Compress tool invoked")
            // logger.info(
            //     JSON.stringify({
            //         startString: startString?.substring(0, 50) + "...",
            //         endString: endString?.substring(0, 50) + "...",
            //         topic: topic,
            //         summaryLength: summary?.length,
            //     }),
            // )

            const messagesResponse = await client.session.messages({
                path: { id: sessionId },
            })
            const messages: WithParts[] = messagesResponse.data || messagesResponse

            await ensureSessionInitialized(
                client,
                state,
                sessionId,
                logger,
                messages,
                ctx.config.manualMode.enabled,
            )

            const transformedMessages = structuredClone(messages) as WithParts[]
            applyPruneTransforms(state, logger, ctx.config, transformedMessages)

            const startResult = findStringInMessages(
                transformedMessages,
                startString,
                logger,
                "startString",
            )
            const endResult = findStringInMessages(
                transformedMessages,
                endString,
                logger,
                "endString",
            )

            let rawStartIndex = messages.findIndex((m) => m.info.id === startResult.messageId)
            let rawEndIndex = messages.findIndex((m) => m.info.id === endResult.messageId)

            // If a boundary matched inside a synthetic compress summary message,
            // resolve it back to the summary's anchor message in the raw messages
            if (rawStartIndex === -1) {
                const summary = state.compressSummaries.find((s) => s.summary.includes(startString))
                if (summary) {
                    rawStartIndex = messages.findIndex((m) => m.info.id === summary.anchorMessageId)
                }
            }
            if (rawEndIndex === -1) {
                const summary = state.compressSummaries.find((s) => s.summary.includes(endString))
                if (summary) {
                    rawEndIndex = messages.findIndex((m) => m.info.id === summary.anchorMessageId)
                }
            }

            if (rawStartIndex === -1 || rawEndIndex === -1) {
                throw new Error(`Failed to map boundary matches back to raw messages`)
            }

            if (rawStartIndex > rawEndIndex) {
                throw new Error(
                    `startString appears after endString in the conversation. Start must come before end.`,
                )
            }

            const containedToolIds = collectToolIdsInRange(messages, rawStartIndex, rawEndIndex)

            const containedMessageIds = collectMessageIdsInRange(
                messages,
                rawStartIndex,
                rawEndIndex,
            )

            // Remove any existing summaries whose anchors are now inside this range
            // This prevents duplicate injections when a larger compress subsumes a smaller one
            const removedSummaries = state.compressSummaries.filter((s) =>
                containedMessageIds.includes(s.anchorMessageId),
            )
            if (removedSummaries.length > 0) {
                state.compressSummaries = state.compressSummaries.filter(
                    (s) => !containedMessageIds.includes(s.anchorMessageId),
                )
            }

            const compressSummary: CompressSummary = {
                anchorMessageId: startResult.messageId,
                summary: summary,
            }
            state.compressSummaries.push(compressSummary)

            const compressedMessageIds = containedMessageIds.filter(
                (id) => !state.prune.messages.has(id),
            )
            const compressedToolIds = containedToolIds.filter((id) => !state.prune.tools.has(id))

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

            state.stats.pruneTokenCounter += estimatedCompressedTokens

            const rawStartResult = { messageId: startResult.messageId, messageIndex: rawStartIndex }
            const rawEndResult = { messageId: endResult.messageId, messageIndex: rawEndIndex }

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

            // logger.info("Compress range created", {
            //     startMessageId: startResult.messageId,
            //     endMessageId: endResult.messageId,
            //     toolIdsRemoved: containedToolIds.length,
            //     messagesInRange: containedMessageIds.length,
            //     estimatedTokens: estimatedCompressedTokens,
            // })

            saveSessionState(state, logger).catch((err) =>
                logger.error("Failed to persist state", { error: err.message }),
            )

            return `Compressed ${compressedMessageIds.length} messages (${compressedToolIds.length} tool calls) into summary. The content will be replaced with your summary.`
        },
    })
}
