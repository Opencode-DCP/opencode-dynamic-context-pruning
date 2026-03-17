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
    resolveBlock,
    resolveTargetId,
    normalizeCompressArgs,
    validateCompressArgs,
    validateSummaryPlaceholders,
    type CompressToolArgs,
} from "./utils"
import { isIgnoredUserMessage } from "../messages/utils"
import { assignMessageRefs } from "../message-ids"
import { getCurrentParams, getCurrentTokenUsage, countTokens } from "../strategies/utils"
import { deduplicate, supersedeWrites, purgeErrors } from "../strategies"
import { saveSessionState } from "../state/persistence"
import { sendCompressNotification } from "../ui/notification"
import { NESTED_FORMAT_OVERLAY, FLAT_FORMAT_OVERLAY } from "../prompts/internal-overlays"

// This schema looks better in the TUI (non primitive args aren't displayed), but LLMs are more likely to fail
// the tool call
function buildNestedSchema() {
    const item = tool.schema.object({
        description: tool.schema
            .string()
            .describe("Short per-block label for display - e.g., 'Auth System Exploration'"),
        targetId: tool.schema
            .string()
            .describe("Visible raw block-scoped message ID to compress (e.g. b12m0123)"),
        summary: tool.schema
            .string()
            .describe("Complete technical summary replacing the selected block"),
    })

    return {
        topic: tool.schema
            .string()
            .describe("Overall batch label - e.g., 'Compressing 5 blocks about auth flow'"),
        content: tool.schema.array(item).describe("One compression entry per selected block"),
    }
}

// Simpler schema for models that are not as good at tool calling reliably
function buildFlatSchema() {
    const item = tool.schema.object({
        description: tool.schema
            .string()
            .describe("Short per-block label for display - e.g., 'Auth System Exploration'"),
        targetId: tool.schema
            .string()
            .describe("Visible raw block-scoped message ID to compress (e.g. b12m0123)"),
        summary: tool.schema
            .string()
            .describe("Complete technical summary replacing the selected block"),
    })

    return {
        topic: tool.schema
            .string()
            .describe("Overall batch label - e.g., 'Compressing 5 blocks about auth flow'"),
        compressions: tool.schema.array(item).describe("One compression entry per selected block"),
    }
}

export function createCompressTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()
    const runtimePrompts = ctx.prompts.getRuntimePrompts()
    const useFlatSchema = ctx.config.compress.flatSchema

    return tool({
        description:
            runtimePrompts.compress + (useFlatSchema ? FLAT_FORMAT_OVERLAY : NESTED_FORMAT_OVERLAY),
        args: useFlatSchema ? buildFlatSchema() : buildNestedSchema(),
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

            const compressArgs = normalizeCompressArgs(args as Record<string, unknown>)
            validateCompressArgs(compressArgs)

            toolCtx.metadata({
                title: `Compress: ${compressArgs.topic}`,
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
            // supersedeWrites(ctx.state, ctx.logger, ctx.config, rawMessages)
            purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

            const resolvedTargets = new Map<string, number>()
            for (const item of compressArgs.content) {
                const searchContext = buildSearchContext(ctx.state, rawMessages)
                const targetReference = resolveTargetId(searchContext, ctx.state, item.targetId)
                const blockId = targetReference.blockId
                if (!blockId) {
                    throw new Error(`Failed to resolve block for targetId ${item.targetId}`)
                }
                const prior = resolvedTargets.get(String(blockId))
                if (prior !== undefined) {
                    throw new Error(
                        `Multiple compression entries target the same block b${blockId}. Choose only one visible message ID per block.`,
                    )
                }
                resolvedTargets.set(String(blockId), blockId)
            }

            let compressedMessageCount = 0
            let compressedBlockCount = 0

            for (const item of compressArgs.content) {
                const searchContext = buildSearchContext(ctx.state, rawMessages)

                const targetReference = resolveTargetId(searchContext, ctx.state, item.targetId)
                const range = resolveBlock(searchContext, ctx.state, targetReference)

                const parsedPlaceholders = parseBlockPlaceholders(item.summary)
                const missingRequiredBlockIds = validateSummaryPlaceholders(
                    parsedPlaceholders,
                    range.requiredBlockIds,
                    searchContext.summaryByBlockId,
                )

                const injected = injectBlockPlaceholders(
                    item.summary,
                    parsedPlaceholders,
                    searchContext.summaryByBlockId,
                )

                const summaryWithUserMessages = appendProtectedUserMessages(
                    injected.expandedSummary,
                    range,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                const summaryWithProtectedTools = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    summaryWithUserMessages,
                    range,
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
                const blockId = allocateBlockId(ctx.state, range.blockId)
                const storedSummary = wrapCompressedSummary(blockId, finalSummary)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: item.description,
                        targetId: item.targetId,
                        compressMessageId: toolCtx.messageID,
                    },
                    range,
                    blockId,
                    storedSummary,
                    finalSummaryResult.consumedBlockIds,
                )

                compressedMessageCount += applied.messageIds.length
                compressedBlockCount++

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
                    blockId,
                    item.summary,
                    summaryTokens,
                    totalSessionTokens,
                    sessionMessageIds,
                    params,
                )
            }

            ctx.state.manualMode = ctx.state.manualMode ? "active" : false
            await saveSessionState(ctx.state, ctx.logger)

            if (compressedBlockCount === 1) {
                return `Compressed ${compressedMessageCount} messages into ${COMPRESSED_BLOCK_HEADER}.`
            }

            return `Compressed ${compressedMessageCount} messages across ${compressedBlockCount} blocks into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
