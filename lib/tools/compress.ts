import { tool } from "@opencode-ai/plugin"
import type { WithParts, CompressSummary } from "../state"
import type { PruneToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { loadPrompt } from "../prompts"
import { estimateTokensBatch, getCurrentParams } from "../strategies/utils"
import {
    collectContentInRange,
    findStringInMessages,
    collectToolIdsInRange,
    collectMessageIdsInRange,
} from "./utils"
import { sendCompressNotification } from "../ui/notification"

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

            await ensureSessionInitialized(client, state, sessionId, logger, messages)

            const startResult = findStringInMessages(
                messages,
                startString,
                logger,
                state.compressSummaries,
                "startString",
            )
            const endResult = findStringInMessages(
                messages,
                endString,
                logger,
                state.compressSummaries,
                "endString",
            )

            if (startResult.messageIndex > endResult.messageIndex) {
                throw new Error(
                    `startString appears after endString in the conversation. Start must come before end.`,
                )
            }

            const containedToolIds = collectToolIdsInRange(
                messages,
                startResult.messageIndex,
                endResult.messageIndex,
            )

            const containedMessageIds = collectMessageIdsInRange(
                messages,
                startResult.messageIndex,
                endResult.messageIndex,
            )

            for (const id of containedToolIds) {
                state.prune.toolIds.add(id)
            }
            for (const id of containedMessageIds) {
                state.prune.messageIds.add(id)
            }

            // Remove any existing summaries whose anchors are now inside this range
            // This prevents duplicate injections when a larger compress subsumes a smaller one
            const removedSummaries = state.compressSummaries.filter((s) =>
                containedMessageIds.includes(s.anchorMessageId),
            )
            if (removedSummaries.length > 0) {
                // logger.info("Removing subsumed compress summaries", {
                //     count: removedSummaries.length,
                //     anchorIds: removedSummaries.map((s) => s.anchorMessageId),
                // })
                state.compressSummaries = state.compressSummaries.filter(
                    (s) => !containedMessageIds.includes(s.anchorMessageId),
                )
            }

            const compressSummary: CompressSummary = {
                anchorMessageId: startResult.messageId,
                summary: summary,
            }
            state.compressSummaries.push(compressSummary)

            const contentsToTokenize = collectContentInRange(
                messages,
                startResult.messageIndex,
                endResult.messageIndex,
            )
            const estimatedCompressedTokens = estimateTokensBatch(contentsToTokenize)

            state.stats.pruneTokenCounter += estimatedCompressedTokens

            const currentParams = getCurrentParams(state, messages, logger)
            await sendCompressNotification(
                client,
                logger,
                ctx.config,
                state,
                sessionId,
                containedToolIds,
                containedMessageIds,
                topic,
                summary,
                startResult,
                endResult,
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

            const messagesCompressed = endResult.messageIndex - startResult.messageIndex + 1
            return `Compressed ${messagesCompressed} messages (${containedToolIds.length} tool calls) into summary. The content will be replaced with your summary.`
        },
    })
}
