import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { COMPRESS_TOOL_SPEC } from "../prompts"
import { ensureSessionInitialized } from "../state"
import {
    addCompressedBlockHeader,
    allocateBlockId,
    applyCompressionState,
    buildSearchContext,
    countSummaryTokens,
    fetchSessionMessages,
    injectBlockPlaceholders,
    parseBlockPlaceholders,
    resolveAnchorMessageId,
    resolveRange,
    scanBoundaryMatches,
    validateBoundaryScan,
    validateCompressArgs,
    validateSummaryPlaceholders,
    type CompressToolArgs,
} from "./compress-utils"
import { getCurrentParams, getCurrentTokenUsage } from "../strategies/utils"
import { saveSessionState } from "../state/persistence"
import { sendCompressNotification } from "../ui/notification"

const COMPRESS_TOOL_DESCRIPTION = COMPRESS_TOOL_SPEC

export function createCompressTool(ctx: ToolContext): ReturnType<typeof tool> {
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
                .describe("Compression details: boundaries and replacement summary"),
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

            const searchContext = buildSearchContext(ctx.state, ctx.logger, ctx.config, rawMessages)

            const scan = scanBoundaryMatches(
                searchContext,
                compressArgs.content.startString,
                compressArgs.content.endString,
                toolCtx.messageID,
            )
            const { startReference, endReference } = validateBoundaryScan(
                scan,
                compressArgs.content.startString,
                compressArgs.content.endString,
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
            const storedSummary = addCompressedBlockHeader(blockId, injected.expandedSummary)
            const summaryTokens = countSummaryTokens(storedSummary)

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
                storedSummary,
                summaryTokens,
                totalSessionTokens,
                applied.compressedTokens,
                sessionMessageIds,
                rawMessages.length,
                params,
            )

            return `Compressed ${applied.messageIds.length} messages into ${formatBlock(blockId)}.`
        },
    })
}

function formatBlock(blockId: number): string {
    return `[Compressed conversation block #${blockId}]`
}
