import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { countTokens } from "../token-utils"
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline"
import { appendProtectedTools, appendProtectedUserMessages } from "./protected-content"
import { resolveRanges, validateNonOverlapping } from "./range-utils"
import {
    COMPRESSED_BLOCK_HEADER,
    allocateBlockId,
    allocateRunId,
    applyCompressionState,
    wrapCompressedSummary,
} from "./state"

const PRUNE_MARKER = "Older context pruned."

interface PruneRangeEntry {
    startId: string
    endId: string
}

interface PruneRangeToolArgs {
    topic: string
    content: PruneRangeEntry[]
}

function buildSchema() {
    return {
        topic: tool.schema
            .string()
            .describe("Short label (3-5 words) - e.g., 'Old exploration pruned'"),
        content: tool.schema
            .array(
                tool.schema.object({
                    startId: tool.schema
                        .string()
                        .describe(
                            "Boundary ID marking the beginning of range (e.g. m0001, b2)",
                        ),
                    endId: tool.schema
                        .string()
                        .describe("Boundary ID marking the end of range (e.g. m0012, b5)"),
                }),
            )
            .describe("One or more ranges to prune (delete from context)"),
    }
}

function validatePruneArgs(args: PruneRangeToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }
    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }
    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`
        if (typeof entry?.startId !== "string" || entry.startId.trim().length === 0) {
            throw new Error(`${prefix}.startId is required and must be a non-empty string`)
        }
        if (typeof entry?.endId !== "string" || entry.endId.trim().length === 0) {
            throw new Error(`${prefix}.endId is required and must be a non-empty string`)
        }
    }
}

const PRUNE_DESCRIPTION = `Delete a range of conversation history, replacing it with a minimal marker. Unlike compress, prune does NOT preserve nested compressed block content — it permanently removes old context to bound total context size.

USE PRUNE WHEN:
- Compressed summaries are dominating context (high Assistant token percentage visible via context metrics)
- The conversation section is fully closed and its details are no longer needed
- Context is near the limit and compress alone cannot reduce it further (because compress preserves all nested blocks, causing monotonic growth)

DO NOT USE PRUNE WHEN:
- The content contains active decisions, constraints, or requirements still in play
- You need to reference the content later
- Compress would be sufficient to manage context

BOUNDARY IDS
Use the same boundary ID format as compress:
- \`mNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Pick IDs directly from injected IDs visible in context.

THE FORMAT OF PRUNE

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Old exploration pruned"
  content: [               // One or more ranges to prune
    {
      startId: string,     // Boundary ID at range start: mNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNN or bN
    }
  ]
}
\`\`\``

export function createPruneRangeTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: PRUNE_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const input = args as PruneRangeToolArgs
            validatePruneArgs(input)
            const callId =
                typeof (toolCtx as unknown as { callID?: unknown }).callID === "string"
                    ? (toolCtx as unknown as { callID: string }).callID
                    : undefined

            const { rawMessages, searchContext } = await prepareSession(
                ctx,
                toolCtx,
                `Prune Range: ${input.topic}`,
            )

            const contentWithSummary = input.content.map((entry) => ({
                startId: entry.startId,
                endId: entry.endId,
                summary: PRUNE_MARKER,
            }))
            const inputWithSummary = { ...input, content: contentWithSummary }

            const resolvedPlans = resolveRanges(inputWithSummary, searchContext, ctx.state)
            validateNonOverlapping(resolvedPlans)

            const notifications: NotificationEntry[] = []
            const preparedPlans: Array<{
                entry: (typeof resolvedPlans)[number]["entry"]
                selection: (typeof resolvedPlans)[number]["selection"]
                anchorMessageId: string
                finalSummary: string
                consumedBlockIds: number[]
            }> = []
            let totalPrunedMessages = 0

            for (const plan of resolvedPlans) {
                // Skip the placeholder expansion pipeline (parseBlockPlaceholders,
                // validateSummaryPlaceholders, injectBlockPlaceholders,
                // appendMissingBlockSummaries) — this is the key difference from
                // compress that prevents monotonic context growth.
                let summary = PRUNE_MARKER

                summary = appendProtectedUserMessages(
                    summary,
                    plan.selection,
                    searchContext,
                    ctx.state,
                    ctx.config.compress.protectUserMessages,
                )

                summary = await appendProtectedTools(
                    ctx.client,
                    ctx.state,
                    ctx.config.experimental.allowSubAgents,
                    summary,
                    plan.selection,
                    searchContext,
                    ctx.config.compress.protectedTools,
                    ctx.config.protectedFilePatterns,
                )

                const consumedBlockIds = [...plan.selection.requiredBlockIds]

                preparedPlans.push({
                    entry: plan.entry,
                    selection: plan.selection,
                    anchorMessageId: plan.anchorMessageId,
                    finalSummary: summary,
                    consumedBlockIds,
                })
            }

            const runId = allocateRunId(ctx.state)

            for (const preparedPlan of preparedPlans) {
                const blockId = allocateBlockId(ctx.state)
                const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary)
                const summaryTokens = countTokens(storedSummary)

                const applied = applyCompressionState(
                    ctx.state,
                    {
                        topic: input.topic,
                        batchTopic: input.topic,
                        startId: preparedPlan.entry.startId,
                        endId: preparedPlan.entry.endId,
                        mode: "prune",
                        runId,
                        compressMessageId: toolCtx.messageID,
                        compressCallId: callId,
                        summaryTokens,
                    },
                    preparedPlan.selection,
                    preparedPlan.anchorMessageId,
                    blockId,
                    storedSummary,
                    preparedPlan.consumedBlockIds,
                )

                totalPrunedMessages += applied.messageIds.length

                notifications.push({
                    blockId,
                    runId,
                    summary: preparedPlan.finalSummary,
                    summaryTokens,
                })
            }

            await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic)

            return `Pruned ${totalPrunedMessages} messages. ${COMPRESSED_BLOCK_HEADER}`
        },
    })
}
