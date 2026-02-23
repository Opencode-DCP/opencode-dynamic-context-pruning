import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { COMPRESS_TOOL_SPEC } from "../prompts"
import { ensureSessionInitialized } from "../state"
import {
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
    validateCompressArgs,
    validateSummaryPlaceholders,
    type CompressToolArgs,
} from "./compress-utils"
import { getCurrentParams, getCurrentTokenUsage, countTokens } from "../strategies/utils"
import { deduplicate, supersedeWrites, purgeErrors } from "../strategies"
import { saveSessionState } from "../state/persistence"
import { sendCompressNotification } from "../ui/notification"

export function createCompressTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: COMPRESS_TOOL_SPEC,
        args: {
            topic: tool.schema
                .string()
                .describe("Short label (3-5 words) for display - e.g., 'Auth System Exploration'"),
            content: tool.schema
                .object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Message or block ID marking the beginning of range (e.g. m0000, b2)",
                        ),
                    endId: tool.schema
                        .string()
                        .describe("Message or block ID marking the end of range (e.g. m0012, b5)"),
                    summary: tool.schema
                        .string()
                        .describe("Complete technical summary replacing all content in range"),
                })
                .describe("Compression details: ID boundaries and replacement summary"),
        },
        async execute(args, toolCtx) {
            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            const compressArgs = args as CompressToolArgs
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

            deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
            // supersedeWrites(ctx.state, ctx.logger, ctx.config, rawMessages)
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
            validateSummaryPlaceholders(
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

            const blockId = allocateBlockId(ctx.state.compressSummaries)
            const storedSummary = wrapCompressedSummary(blockId, injected.expandedSummary)
            const summaryTokens = countTokens(storedSummary)

            const applied = applyCompressionState(
                ctx.state,
                range,
                anchorMessageId,
                blockId,
                storedSummary,
                injected.consumedBlockIds,
            )

            await saveSessionState(ctx.state, ctx.logger)

            const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
            const totalSessionTokens = getCurrentTokenUsage(rawMessages)
            const sessionMessageIds = rawMessages.map((msg) => msg.info.id)

            await sendCompressNotification(
                ctx.client,
                ctx.logger,
                ctx.config,
                ctx.state,
                toolCtx.sessionID,
                range.toolIds,
                applied.messageIds,
                compressArgs.topic,
                injected.expandedSummary,
                summaryTokens,
                totalSessionTokens,
                applied.compressedTokens,
                sessionMessageIds,
                rawMessages.length,
                params,
            )

            return `Compressed ${applied.messageIds.length} messages into ${COMPRESSED_BLOCK_HEADER}.`
        },
    })
}
