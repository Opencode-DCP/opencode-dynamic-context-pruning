import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { renderBlockForContext, type BlockLike } from "./renderer"
import { MESSAGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
import { formatIssues, formatResult, resolveMessages, validateArgs } from "./message-utils"
import { withSessionLock } from "../state/lock"
import {
    RebaseConflict,
    persistCompressionState,
    prepareSession,
    rebasePlannedCompression,
    reloadLatestState,
    sendCompressionNotification,
    type NotificationEntry,
} from "./pipeline"
import { appendProtectedPromptInfo, appendProtectedTools } from "./protected-content"
import { assertUsefulCompressedSummary, estimateSelectedTokens } from "./summary-limits"
import {
    allocateRunId,
    applyCompressionState,
    previewBlockIds,
    reserveBlockIds,
    wrapCompressedSummary,
} from "./state"
import type { CompressMessageToolArgs } from "./types"

const MAX_REBASE_ATTEMPTS = 3

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
        description: runtimePrompts.compressMessage + MESSAGE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as CompressMessageToolArgs
            validateArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            for (let attempt = 1; attempt <= MAX_REBASE_ATTEMPTS; attempt++) {
                try {
                    const { rawMessages, searchContext } = await prepareSession(
                        ctx,
                        toolCtx,
                        `Compress Message: ${input.topic}`,
                    )
                    const { plans, skippedIssues, skippedCount } = resolveMessages(
                        input,
                        searchContext,
                        ctx.state,
                        ctx.config,
                    )

                    if (plans.length === 0 && skippedCount > 0) {
                        throw new Error(formatIssues(skippedIssues, skippedCount))
                    }

                    const preparedPlans: Array<{
                        plan: (typeof plans)[number]
                        summaryWithTools: string
                    }> = []

                    for (const plan of plans) {
                        const summaryWithPromptInfo = appendProtectedPromptInfo(
                            plan.entry.summary,
                            plan.selection,
                            searchContext,
                            ctx.state,
                            ctx.config.compress.protectTags,
                        )

                        const summaryWithTools = await appendProtectedTools(
                            ctx.client,
                            ctx.state,
                            ctx.config.experimental.allowSubAgents,
                            summaryWithPromptInfo,
                            plan.selection,
                            searchContext,
                            ctx.config.compress.protectedTools,
                            ctx.config.protectedFilePatterns,
                        )

                        preparedPlans.push({
                            plan,
                            summaryWithTools,
                        })
                    }

                    const result = await withSessionLock(toolCtx.sessionID, async () => {
                        await reloadLatestState(ctx.state, toolCtx.sessionID, ctx.logger)
                        rebasePlannedCompression(plans, ctx.state)

                        const notifications: NotificationEntry[] = []
                        const blockIds = previewBlockIds(ctx.state, preparedPlans.length)
                        const validatedPlans = preparedPlans.map(
                            ({ plan, summaryWithTools }, index) => {
                                const blockId = blockIds[index]
                                if (blockId === undefined) {
                                    throw new Error("Failed to preview compression block ID")
                                }

                                const wrapResult = wrapCompressedSummary({
                                    blockId,
                                    modelSummary: summaryWithTools,
                                    consumedBlocks: [],
                                    blocksById: searchContext.summaryByBlockId,
                                    mode: "message",
                                })
                                const { storedSummary } = wrapResult
                                const { refBlockIds } = wrapResult

                                // Phase 0 Contract A: render the draft block against a draft Map so we can
                                // measure tokens WITHOUT mutating state.prune.messages.blocksById. The draft
                                // is committed only after assertUsefulCompressedSummary passes and
                                // reserveBlockIds/applyCompressionState succeed below.
                                // wrapCompressedSummary returns draftBlock already populated with refBlockIds
                                // and schemaVersion: 2 from the exact-substring dedup pass (T8). Message mode
                                // never consumes prior blocks so refBlockIds is always [] here; summaryTokens
                                // remains 0 until renderBlockForContext fills it in below (T12 prep).
                                const draftBlock: BlockLike & { summaryTokens: number } =
                                    wrapResult.draftBlock
                                const draftBlocksById = new Map<number, BlockLike>(
                                    ctx.state.prune.messages.blocksById,
                                )
                                draftBlocksById.set(blockId, draftBlock)
                                const { renderedTokens } = renderBlockForContext(
                                    blockId,
                                    draftBlocksById,
                                )
                                draftBlock.summaryTokens = renderedTokens
                                const summaryTokens = renderedTokens
                                const selectedTokens = estimateSelectedTokens(ctx.state, plan.selection)
                                assertUsefulCompressedSummary(summaryTokens, selectedTokens)

                                return {
                                    plan,
                                    summaryWithTools,
                                    blockId,
                                    storedSummary,
                                    refBlockIds,
                                    summaryTokens,
                                }
                            },
                        )

                        reserveBlockIds(ctx.state, validatedPlans.length)
                        const runId = allocateRunId(ctx.state)

                        for (const validatedPlan of validatedPlans) {
                            const { plan, summaryWithTools, blockId, storedSummary, summaryTokens } =
                                validatedPlan

                            applyCompressionState(
                                ctx.state,
                                {
                                    topic: plan.entry.topic,
                                    batchTopic: input.topic,
                                    startId: plan.entry.messageId,
                                    endId: plan.entry.messageId,
                                    mode: "message",
                                    runId,
                                    compressMessageId: toolCtx.messageID,
                                    compressCallId: callId,
                                    summaryTokens,
                                    refBlockIds: validatedPlan.refBlockIds,
                                },
                                plan.selection,
                                plan.anchorMessageId,
                                blockId,
                                storedSummary,
                                [],
                            )

                            notifications.push({
                                blockId,
                                runId,
                                summary: summaryWithTools,
                                summaryTokens,
                            })
                        }

                        await persistCompressionState(ctx.state, toolCtx.sessionID, ctx.logger)

                        return { notifications }
                    })

                    await sendCompressionNotification(
                        ctx,
                        toolCtx,
                        rawMessages,
                        result.notifications,
                        input.topic,
                    )

                    return formatResult(plans.length, skippedIssues, skippedCount)
                } catch (error) {
                    if (error instanceof RebaseConflict && attempt < MAX_REBASE_ATTEMPTS) {
                        continue
                    }
                    throw error
                }
            }

            throw new Error("Failed to compress messages after rebase retries")
        },
    })
}
