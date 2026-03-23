import type { PluginConfig } from "../config"
import type { SessionState } from "../state"
import { parseBoundaryId } from "../message-ids"
import { isIgnoredUserMessage, isProtectedUserMessage } from "../messages/utils"
import { resolveAnchorMessageId, resolveBoundaryIds, resolveSelection } from "./search"
import { COMPRESSED_BLOCK_HEADER } from "./state"
import type {
    CompressMessageEntry,
    CompressMessageToolArgs,
    ResolvedMessageCompression,
    ResolvedMessageCompressionsResult,
    SearchContext,
} from "./types"

class SoftIssue extends Error {}

export function validateArgs(args: CompressMessageToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (!Array.isArray(args.content) || args.content.length === 0) {
        throw new Error("content is required and must be a non-empty array")
    }

    for (let index = 0; index < args.content.length; index++) {
        const entry = args.content[index]
        const prefix = `content[${index}]`

        if (typeof entry?.messageId !== "string" || entry.messageId.trim().length === 0) {
            throw new Error(`${prefix}.messageId is required and must be a non-empty string`)
        }

        if (typeof entry?.topic !== "string" || entry.topic.trim().length === 0) {
            throw new Error(`${prefix}.topic is required and must be a non-empty string`)
        }

        if (typeof entry?.summary !== "string" || entry.summary.trim().length === 0) {
            throw new Error(`${prefix}.summary is required and must be a non-empty string`)
        }
    }
}

export function formatResult(processedCount: number, skippedIssues: string[]): string {
    const messageNoun = processedCount === 1 ? "message" : "messages"
    const processedText =
        processedCount > 0
            ? `Compressed ${processedCount} ${messageNoun} into ${COMPRESSED_BLOCK_HEADER}.`
            : "Compressed 0 messages."

    if (skippedIssues.length === 0) {
        return processedText
    }

    const issueNoun = skippedIssues.length === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `${processedText}\nSkipped ${skippedIssues.length} ${issueNoun}:\n${issueLines}`
}

export function formatIssues(skippedIssues: string[]): string {
    const issueNoun = skippedIssues.length === 1 ? "issue" : "issues"
    const issueLines = skippedIssues.map((issue) => `- ${issue}`).join("\n")
    return `Unable to compress any messages. Found ${skippedIssues.length} ${issueNoun}:\n${issueLines}`
}

export function resolveMessages(
    args: CompressMessageToolArgs,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompressionsResult {
    const issues: string[] = []
    const plans: ResolvedMessageCompression[] = []
    const seenMessageIds = new Set<string>()

    for (const entry of args.content) {
        const normalizedMessageId = entry.messageId.trim()
        if (seenMessageIds.has(normalizedMessageId)) {
            issues.push(
                `messageId ${normalizedMessageId} was selected more than once in this batch.`,
            )
            continue
        }

        try {
            const plan = resolveMessage(
                {
                    ...entry,
                    messageId: normalizedMessageId,
                },
                searchContext,
                state,
                config,
            )
            seenMessageIds.add(plan.entry.messageId)
            plans.push(plan)
        } catch (error: any) {
            if (error instanceof SoftIssue) {
                issues.push(error.message)
                continue
            }

            throw error
        }
    }

    return {
        plans,
        skippedIssues: issues,
    }
}

function resolveMessage(
    entry: CompressMessageEntry,
    searchContext: SearchContext,
    state: SessionState,
    config: PluginConfig,
): ResolvedMessageCompression {
    if (entry.messageId.toUpperCase() === "BLOCKED") {
        throw new SoftIssue(
            "messageId BLOCKED refers to a protected message and cannot be compressed.",
        )
    }

    const parsed = parseBoundaryId(entry.messageId)

    if (!parsed) {
        throw new Error(
            `messageId ${entry.messageId} is invalid. Use an injected raw message ID of the form mNNNN.`,
        )
    }

    if (parsed.kind === "compressed-block") {
        throw new SoftIssue(
            `messageId ${entry.messageId} is invalid here. Block IDs like bN are not allowed; use an mNNNN message ID instead.`,
        )
    }

    const messageId = state.messageIds.byRef.get(parsed.ref)
    const rawMessage = messageId ? searchContext.rawMessagesById.get(messageId) : undefined
    const hasBoundary =
        !!rawMessage &&
        !!messageId &&
        searchContext.rawIndexById.has(messageId) &&
        !(rawMessage.info.role === "user" && isIgnoredUserMessage(rawMessage))
    if (!hasBoundary) {
        throw new SoftIssue(
            `messageId ${parsed.ref} is not available in the current conversation context. Choose an injected mNNNN ID visible in context.`,
        )
    }

    const { startReference, endReference } = resolveBoundaryIds(
        searchContext,
        state,
        parsed.ref,
        parsed.ref,
    )
    const selection = resolveSelection(searchContext, startReference, endReference)
    const rawMessageId = selection.messageIds[0]

    if (!rawMessageId) {
        throw new Error(`messageId ${parsed.ref} could not be resolved to a raw message.`)
    }

    const message = searchContext.rawMessagesById.get(rawMessageId)
    if (!message) {
        throw new Error(`messageId ${parsed.ref} is not available in the current conversation.`)
    }

    if (isProtectedUserMessage(config, message)) {
        throw new SoftIssue(
            `messageId ${parsed.ref} refers to a protected message and cannot be compressed.`,
        )
    }

    const pruneEntry = state.prune.messages.byMessageId.get(rawMessageId)
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
        throw new Error(`messageId ${parsed.ref} is already part of an active compression.`)
    }

    return {
        entry: {
            messageId: parsed.ref,
            topic: entry.topic,
            summary: entry.summary,
        },
        selection,
        anchorMessageId: resolveAnchorMessageId(startReference),
    }
}
