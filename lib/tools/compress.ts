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
    resolveAnchorMessageId,
    resolveBoundaryIds,
    resolveRange,
    normalizeCompressArgs,
    validateCompressArgs,
    validateSummaryPlaceholders,
    type CompressToolArgs,
} from "./utils"
import { isIgnoredUserMessage } from "../messages/utils"
import { assignMessageRefs } from "../message-ids"
import { getCurrentParams, getCurrentTokenUsage, countTokens } from "../strategies/utils"
import { deduplicate, purgeErrors } from "../strategies"
import { saveSessionState } from "../state/persistence"
import { sendCompressNotification } from "../ui/notification"
import { NESTED_FORMAT_OVERLAY, FLAT_FORMAT_OVERLAY } from "../prompts/internal-overlays"

// This schema looks better in the TUI (non primitive args aren't displayed), but LLMs are more likely to fail
// the tool call
function buildNestedSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        content: tool.schema
            .object({
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
            })
            .describe("Compression details: ID boundaries and replacement summary"),
    }
}

// Simpler schema for models that are not as good at tool calling reliably
function buildFlatSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
        startId: tool.schema
            .string()
            .describe("Message or block ID marking the beginning of range (e.g. m0001, b2)"),
        endId: tool.schema
            .string()
            .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
        summary: tool.schema
            .string()
            .describe("Complete technical summary replacing all content in range"),
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
            purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

            const searchContext = buildSearchContext(ctx.state, rawMessages)

            const { startReference, endReference } = resolveBoundaryIds(
                searchContext,
                ctx.state,
                compressArgs.content.startId,
                compressArgs.content.endId,
            )

            const range = resolveRange(searchContext, startReference, endReference)
            const anchorMessageId = resolveAnchorMessageId(range.startReference)

            const parsedPlaceholders = parseBlockPlaceholders(compressArgs.content.summary)
            const missingRequiredBlockIds = validateSummaryPlaceholders(
                parsedPlaceholders,
                range.requiredBlockIds,
                range.startReference,
                range.endReference,
                searchContext.summaryByBlockId,
            )

            const injected = injectBlockPlaceholders(
                compressArgs.content.summary,
                parsedPlaceholders,
                searchContext.summaryByBlockId,
                range.startReference,
                range.endReference,
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

            const blockId = allocateBlockId(ctx.state)
            const storedSummary = wrapCompressedSummary(blockId, finalSummary)
            const summaryTokens = countTokens(storedSummary)

            const applied = applyCompressionState(
                ctx.state,
                {
                    topic: compressArgs.topic,
                    startId: compressArgs.content.startId,
                    endId: compressArgs.content.endId,
                    compressMessageId: toolCtx.messageID,
                },
                range,
                anchorMessageId,
                blockId,
                storedSummary,
                finalSummaryResult.consumedBlockIds,
            )

            ctx.state.manualMode = ctx.state.manualMode ? "active" : false
            await saveSessionState(ctx.state, ctx.logger)

            const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
            const totalSessionTokens = getCurrentTokenUsage(rawMessages)
            const sessionMessages = rawMessages.filter(
                (msg) => !(msg.info.role === "user" && isIgnoredUserMessage(msg)),
            )

            await sendCompressNotification(
                ctx.client,
                ctx.logger,
                ctx.config,
                ctx.state,
                toolCtx.sessionID,
                blockId,
                compressArgs.content.summary,
                summaryTokens,
                totalSessionTokens,
                sessionMessages,
                params,
            )

            return `Compressed ${applied.messageIds.length} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
