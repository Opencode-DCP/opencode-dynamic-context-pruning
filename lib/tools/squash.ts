import { tool } from "@opencode-ai/plugin"
import type { WithParts, SquashSummary } from "../state"
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
import { sendSquashNotification } from "../ui/notification"

const SQUASH_TOOL_DESCRIPTION = loadPrompt("squash-tool-spec")

export function createSquashTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: SQUASH_TOOL_DESCRIPTION,
        args: {
            input: tool.schema
                .array(tool.schema.string())
                .length(4)
                .describe(
                    "[startString, endString, topic, summary] - 4 required strings: (1) startString: unique text from conversation marking range start, (2) endString: unique text marking range end, (3) topic: short 3-5 word label for UI, (4) summary: comprehensive text replacing all squashed content",
                ),
        },
        async execute(args, toolCtx) {
            const { client, state, logger } = ctx
            const sessionId = toolCtx.sessionID

            const [startString, endString, topic, summary] = args.input

            logger.info("Squash tool invoked")
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
                state.squashSummaries,
                "startString",
            )
            const endResult = findStringInMessages(
                messages,
                endString,
                logger,
                state.squashSummaries,
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

            state.prune.toolIds.push(...containedToolIds)
            state.prune.messageIds.push(...containedMessageIds)

            // Remove any existing summaries whose anchors are now inside this range
            // This prevents duplicate injections when a larger squash subsumes a smaller one
            const removedSummaries = state.squashSummaries.filter((s) =>
                containedMessageIds.includes(s.anchorMessageId),
            )
            if (removedSummaries.length > 0) {
                // logger.info("Removing subsumed squash summaries", {
                //     count: removedSummaries.length,
                //     anchorIds: removedSummaries.map((s) => s.anchorMessageId),
                // })
                state.squashSummaries = state.squashSummaries.filter(
                    (s) => !containedMessageIds.includes(s.anchorMessageId),
                )
            }

            const squashSummary: SquashSummary = {
                anchorMessageId: startResult.messageId,
                summary: summary,
            }
            state.squashSummaries.push(squashSummary)

            const contentsToTokenize = collectContentInRange(
                messages,
                startResult.messageIndex,
                endResult.messageIndex,
            )
            const estimatedSquashedTokens = estimateTokensBatch(contentsToTokenize)

            state.stats.pruneTokenCounter += estimatedSquashedTokens

            const currentParams = getCurrentParams(state, messages, logger)
            await sendSquashNotification(
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

            // logger.info("Squash range created", {
            //     startMessageId: startResult.messageId,
            //     endMessageId: endResult.messageId,
            //     toolIdsRemoved: containedToolIds.length,
            //     messagesInRange: containedMessageIds.length,
            //     estimatedTokens: estimatedSquashedTokens,
            // })

            saveSessionState(state, logger).catch((err) =>
                logger.error("Failed to persist state", { error: err.message }),
            )

            const messagesSquashed = endResult.messageIndex - startResult.messageIndex + 1
            return `Squashed ${messagesSquashed} messages (${containedToolIds.length} tool calls) into summary. The content will be replaced with your summary.`
        },
    })
}
