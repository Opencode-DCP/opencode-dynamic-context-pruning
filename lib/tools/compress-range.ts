import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import {
    appendMissingBlockSummaries,
    appendProtectedUserMessages,
    appendProtectedTools,
    wrapCompressedSummary,
    allocateBlockId,
    applyCompressionState,
    buildSearchContext,
    fetchSessionMessages,
    COMPRESSED_BLOCK_HEADER,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRangeCompressions,
    validateNonOverlappingRangeCompressions,
    validateCompressRangeArgs,
    validateSummaryPlaceholders,
} from "./utils"
import { isIgnoredUserMessage } from "../messages/utils"
import { assignMessageRefs } from "../message-ids"
import { getCurrentParams, getCurrentTokenUsage, countTokens } from "../strategies/utils"
import { deduplicate, purgeErrors } from "../strategies"
import { saveSessionState } from "../state/persistence"
import { sendCompressNotification } from "../ui/notification"
import { RANGE_FORMAT_OVERLAY } from "../prompts/internal-overlays"

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Message or block ID marking the beginning of range (e.g. m0001, b2)",
                        ),
                    endId: tool.schema
                        .string()
                        .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                }),
            )
            .describe(
                "One or more ranges to compress, each with start/end boundaries and a summary",
            ),
    }
}

export function createCompressRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressRange + RANGE_FORMAT_OVERLAY,
        args: buildSchema(),
        async execute(args, toolCtx) {
            if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
                throw new Error(
                    "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
                )
            }

            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const compressRangeArgs = args
            validateCompressRangeArgs(compressRangeArgs)

            toolCtx.metadata({
                title: `Compress Range: ${compressRangeArgs.topic}`,
            })

            const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

            await ensureSessionInitialized(
                ctx.client,
                ctx.state,
                toolCtx.sessionID,
                ctx.logger,
                rawMessages,
                ctx.config.manualMode.enabled,
            )

            assignMessageRefs(ctx.state, rawMessages)

            deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
            purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

            const searchContext = buildSearchContext(ctx.state, rawMessages)
            const resolvedPlans = resolveRangeCompressions(
                compressRangeArgs,
                searchContext,
                ctx.state,
            )
            validateNonOverlappingRangeCompressions(resolvedPlans)

            const notificationEntries: Array<{
                blockId: number
                summary: string
                summaryTokens: number
            }> = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                range: (typeof resolvedPlans)[number]["range"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalCompressedMessages = 0

            for (const plan of resolvedPlans) {
                const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                const missingRequiredBlockIds = validateSummaryPlaceholders(
                    parsedPlaceholders,
                    plan.range.requiredBlockIds,
                    plan.range.startReference,
                    plan.range.endReference,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    plan.entry.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                    plan.range.startReference,
                    plan.range.endReference,
                )

                const summaryWithUserMessages = appendProtectedUserMessages(
                    injected.expandedSummary,
                    plan.range,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithProtectedTools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    summaryWithUserMessages,
                    plan.range,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                const finalSummaryResult = appendMissingBlockSummaries(
                    summaryWithProtectedTools,
                    missingRequiredBlockIds,
                    searchContext.summaryByBlockId,
                    injected.consumedBlockIds,
                )

                const finalSummary = finalSummaryResult.expandedSummary

                preparedPlans.push({
                    entry: plan.entry,
                    range: plan.range,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary,
                    consumedBlockIds: finalSummaryResult.consumedBlockIds,
                })
            }

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: compressRangeArgs.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        compressMessageId: toolCtx.messageID,
                    },
                    preparedPlan.range,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                )

                totalCompressedMessages += applied.messageIds.length

                notificationEntries.push({
                    blockId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            ctx.state.manualMode = ctx.state.manualMode ? "active" : false
            await saveSessionState(ctx.state, ctx.logger)

            const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
            const totalSessionTokens = getCurrentTokenUsage(rawMessages)
            const sessionMessageIds = rawMessages
                .filter((msg) => !(msg.info.role === "user" && isIgnoredUserMessage(msg)))
                .map((msg) => msg.info.id)

            await sendCompressNotification(
                ctx.client,
                ctx.logger,
                ctx.config,
                ctx.state,
                toolCtx.sessionID,
                notificationEntries,
                compressRangeArgs.topic,
                totalSessionTokens,
                sessionMessageIds,
                params,
            )

            return `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
