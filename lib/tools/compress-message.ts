import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import {
    appendProtectedTools,
    wrapCompressedSummary,
    allocateBlockId,
    applyCompressionState,
    buildSearchContext,
    fetchSessionMessages,
    formatCompressMessageIssues,
    formatCompressMessageResult,
    resolveMessageCompressions,
    validateCompressMessageArgs,
    type CompressMessageToolArgs,
} from "./utils"
import { isIgnoredUserMessage } from "../messages/utils"
import { assignMessageRefs } from "../message-ids"
import { getCurrentParams, getCurrentTokenUsage, countTokens } from "../strategies/utils"
import { deduplicate, purgeErrors } from "../strategies"
import { saveSessionState } from "../state/persistence"
import { sendCompressNotification } from "../ui/notification"
import { MESSAGE_FORMAT_OVERLAY } from "../prompts/internal-overlays"

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe(
                "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'",
            ),
        content: tool.schema
            .array(
                tool.schema.object({
                    messageId: tool.schema
                        .string()
                        .describe("Raw message ID to compress (e.g. m0001)"),
                    topic: tool.schema
                        .string()
                        .describe("Short label (3-5 words) for this one message summary"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing that one message"),
                }),
            )
            .describe("Batch of individual message summaries to create in one tool call"),
    }
}

export function createCompressMessageTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()

    return tool({
        description: runtimePrompts.compressMessage + MESSAGE_FORMAT_OVERLAY,
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

            const compressMessageArgs = args as CompressMessageToolArgs
            validateCompressMessageArgs(compressMessageArgs)

            toolCtx.metadata({
                title: `Compress Message: ${compressMessageArgs.topic}`,
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
            const { plans, skippedIssues } = resolveMessageCompressions(
                compressMessageArgs,
                searchContext,
                ctx.state,
            )

            if (plans.length === 0 && skippedIssues.length > 0) {
                throw new Error(formatCompressMessageIssues(skippedIssues))
            }

            const notificationBlocks: Array<{
                blockId: number
                summary: string
                summaryTokens: number
            }> = []

            const preparedPlans: Array<{
                plan: (typeof plans)[number]
                summaryWithProtectedTools: string
            }> = []

            for (const plan of plans) {
                const summaryWithProtectedTools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    plan.entry.summary,
                    plan.range,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                preparedPlans.push({
                    plan,
                    summaryWithProtectedTools,
                })
            }

            for (const { plan, summaryWithProtectedTools } of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, summaryWithProtectedTools)
                const summaryTokens = countTokens(storedSummary)

                applyCompressionState(
                    ctx.state,
                    {
                        topic: plan.entry.topic,
                        startId: plan.entry.messageId,
                        endId: plan.entry.messageId,
                        compressMessageId: toolCtx.messageID,
                    },
                    plan.range,
                    plan.anchorMessageId,
                    blockId,
                    storedSummary,
                    [],
                )

                notificationBlocks.push({
                    blockId,
                    summary: summaryWithProtectedTools,
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
                notificationBlocks,
                compressMessageArgs.topic,
                totalSessionTokens,
                sessionMessageIds,
                params,
            )

            return formatCompressMessageResult(plans.length, skippedIssues)
        },
    })
}
