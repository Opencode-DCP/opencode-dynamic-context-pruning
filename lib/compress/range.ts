import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { renderBlockForContext, type BlockLike } from "./renderer"
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool"
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
import {
    appendProtectedPromptInfo,
    appendProtectedTools,
    appendProtectedUserMessages,
} from "./protected-content"
import {
    appendMissingBlockSummaries,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveRanges,
    validateArgs,
    validateNonOverlapping,
    validateSummaryPlaceholders,
} from "./range-utils"
import { assertUsefulCompressedSummary, estimateSelectedTokens } from "./summary-limits"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateRunId,
    applyCompressionState,
    previewBlockIds,
    reserveBlockIds,
    wrapCompressedSummary,
} from "./state"
import type { CompressRangeToolArgs } from "./types"

const MAX_REBASE_ATTEMPTS = 3

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
        description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as CompressRangeToolArgs
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
                        `Compress Range: ${input.topic}`,
                    )
                    const resolvedPlans = resolveRanges(input, searchContext, ctx.state)
                    validateNonOverlapping(resolvedPlans)

                    const result = await withSessionLock(toolCtx.sessionID, async () => {
                        await reloadLatestState(ctx.state, toolCtx.sessionID, ctx.logger)
                        rebasePlannedCompression(resolvedPlans, ctx.state)

                        const blockIds = previewBlockIds(ctx.state, resolvedPlans.length)
                        const notifications: NotificationEntry[] = []
                        const preparedPlans: Array<{
                            entry: (typeof resolvedPlans)[number]["entry"]
                            selection: (typeof resolvedPlans)[number]["selection"]
                            anchorMessageId: string
                            finalSummary: string
                            consumedBlockIds: number[]
                        }> = []
                        let totalCompressedMessages = 0

                        for (const [index, plan] of resolvedPlans.entries()) {
                            const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary)
                            const missingBlockIds = validateSummaryPlaceholders(
                                parsedPlaceholders,
                                plan.selection.requiredBlockIds,
                                blockIds[index] ?? 0,
                                plan.selection.startReference,
                                plan.selection.endReference,
                                searchContext.summaryByBlockId,
                            )

                            const injected = injectBlockPlaceholders(
                                plan.entry.summary,
                                parsedPlaceholders,
                                searchContext.summaryByBlockId,
                                plan.selection.startReference,
                                plan.selection.endReference,
                                new Set(plan.selection.requiredBlockIds),
                            )

                            const summaryWithUsers = appendProtectedUserMessages(
                                injected.expandedSummary,
                                plan.selection,
                                searchContext,
                                ctx.state,
                                ctx.config.compress.protectUserMessages,
                            )

                            const summaryWithPromptInfo = appendProtectedPromptInfo(
                                summaryWithUsers,
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

                            const completedSummary = appendMissingBlockSummaries(
                                summaryWithTools,
                                missingBlockIds,
                                searchContext.summaryByBlockId,
                                injected.consumedBlockIds,
                            )

                            preparedPlans.push({
                                entry: plan.entry,
                                selection: plan.selection,
                                anchorMessageId: plan.anchorMessageId,
                                finalSummary: completedSummary.expandedSummary,
                                consumedBlockIds: completedSummary.consumedBlockIds,
                            })
                        }

                        const validatedPlans = preparedPlans.map((preparedPlan, index) => {
                            const blockId = blockIds[index]
                            if (blockId === undefined) {
                                throw new Error("Failed to preview compression block ID")
                            }

                            const consumedBlocks: Array<{
                                id: number
                                summary: string
                                schemaVersion?: number
                            }> = []
                            for (const consumedId of preparedPlan.consumedBlockIds) {
                                const consumed = searchContext.summaryByBlockId.get(consumedId)
                                if (!consumed) {
                                    continue
                                }
                                consumedBlocks.push({
                                    id: consumedId,
                                    summary: consumed.summary,
                                    schemaVersion: consumed.schemaVersion,
                                })
                            }

                            const wrapResult = wrapCompressedSummary({
                                blockId,
                                modelSummary: preparedPlan.finalSummary,
                                consumedBlocks,
                                blocksById: searchContext.summaryByBlockId,
                                mode: "range",
                            })
                            const { storedSummary, refBlockIds } = wrapResult

                            // Phase 0 Contract A: render the draft block against a draft Map so we can
                            // measure tokens WITHOUT mutating state.prune.messages.blocksById. The draft
                            // is committed only after assertUsefulCompressedSummary passes and
                            // reserveBlockIds/applyCompressionState succeed below.
                            // wrapCompressedSummary returns draftBlock already populated with refBlockIds
                            // and schemaVersion: 2 from the exact-substring dedup pass (T8); summaryTokens
                            // remains 0 until renderBlockForContext fills it in here (T12 prep).
                            const draftBlock: BlockLike & { summaryTokens: number } =
                                wrapResult.draftBlock
                            const draftBlocksById = new Map<number, BlockLike>(
                                ctx.state.prune.messages.blocksById,
                            )
                            draftBlocksById.set(blockId, draftBlock)
                            const { renderedTokens } = renderBlockForContext(blockId, draftBlocksById)
                            draftBlock.summaryTokens = renderedTokens
                            const summaryTokens = renderedTokens
                            const selectedTokens = estimateSelectedTokens(
                                ctx.state,
                                preparedPlan.selection,
                                preparedPlan.consumedBlockIds,
                            )
                            assertUsefulCompressedSummary(summaryTokens, selectedTokens)

                            return {
                                ...preparedPlan,
                                blockId,
                                storedSummary,
                                refBlockIds,
                                summaryTokens,
                            }
                        })

                        reserveBlockIds(ctx.state, validatedPlans.length)
                        const runId = allocateRunId(ctx.state)

                        for (const preparedPlan of validatedPlans) {
                            const applied = applyCompressionState(
                                ctx.state,
                                {
                                    topic: input.topic,
                                    batchTopic: input.topic,
                                    startId: preparedPlan.entry.startId,
                                    endId: preparedPlan.entry.endId,
                                    mode: "range",
                                    runId,
                                    compressMessageId: toolCtx.messageID,
                                    compressCallId: callId,
                                    summaryTokens: preparedPlan.summaryTokens,
                                    refBlockIds: preparedPlan.refBlockIds,
                                },
                                preparedPlan.selection,
                                preparedPlan.anchorMessageId,
                                preparedPlan.blockId,
                                preparedPlan.storedSummary,
                                preparedPlan.consumedBlockIds,
                            )

                            totalCompressedMessages += applied.messageIds.length

                            notifications.push({
                                blockId: preparedPlan.blockId,
                                runId,
                                summary: preparedPlan.finalSummary,
                                summaryTokens: preparedPlan.summaryTokens,
                            })
                        }

                        await persistCompressionState(ctx.state, toolCtx.sessionID, ctx.logger)

                        return { notifications, totalCompressedMessages }
                    })

                    await sendCompressionNotification(
                        ctx,
                        toolCtx,
                        rawMessages,
                        result.notifications,
                        input.topic,
                    )

                    return `Compressed ${result.totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`
                } catch (error) {
                    if (error instanceof RebaseConflict && attempt < MAX_REBASE_ATTEMPTS) {
                        continue
                    }
                    throw error
                }
            }

            throw new Error("Failed to compress range after rebase retries")
        },
    })
}
