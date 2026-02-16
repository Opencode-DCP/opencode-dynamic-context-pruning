import type { SessionState, WithParts, CompressSummary } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { formatBlockRef, parseBoundaryId } from "../message-ids"
import { prune } from "../messages"
import { isIgnoredUserMessage } from "../messages/utils"
import { countAllMessageTokens, countTokens } from "../strategies/utils"

const BLOCK_PLACEHOLDER_REGEX = /\{block_(\d+)\}/gi
const COMPRESSED_BLOCK_HEADER_PREFIX_REGEX = /^\s*\[Compressed conversation b(\d+)\]/i

export interface CompressToolArgs {
    topic: string
    content: {
        startId: string
        endId: string
        summary: string
    }
}

export interface BoundaryReference {
    kind: "message" | "compressed-block"
    transformedIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    transformedMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    summaryByBlockId: Map<number, CompressSummary>
}

export interface RangeResolution {
    startReference: BoundaryReference
    endReference: BoundaryReference
    messageIds: string[]
    messageTokenById: Map<string, number>
    toolIds: string[]
    requiredBlockIds: number[]
}

export interface ParsedBlockPlaceholder {
    raw: string
    blockId: number
    startIndex: number
    endIndex: number
}

export interface InjectedSummaryResult {
    expandedSummary: string
    consumedBlockIds: number[]
}

export interface AppliedCompressionResult {
    compressedTokens: number
    messageIds: string[]
}

export function formatCompressedBlockHeader(blockId: number): string {
    return `[Compressed conversation b${blockId}]`
}

export function formatBlockPlaceholder(blockId: number): string {
    return `{block_${blockId}}`
}

export function validateCompressArgs(args: CompressToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (typeof args.content?.startId !== "string" || args.content.startId.trim().length === 0) {
        throw new Error("content.startId is required and must be a non-empty string")
    }

    if (parseBoundaryId(args.content.startId) === null) {
        throw new Error("content.startId must be a valid message/block ID (mNNNN or bN)")
    }

    if (typeof args.content?.endId !== "string" || args.content.endId.trim().length === 0) {
        throw new Error("content.endId is required and must be a non-empty string")
    }

    if (parseBoundaryId(args.content.endId) === null) {
        throw new Error("content.endId must be a valid message/block ID (mNNNN or bN)")
    }

    if (typeof args.content?.summary !== "string" || args.content.summary.trim().length === 0) {
        throw new Error("content.summary is required and must be a non-empty string")
    }
}

export async function fetchSessionMessages(client: any, sessionId: string): Promise<WithParts[]> {
    const response = await client.session.messages({
        path: { id: sessionId },
    })

    const payload = (response?.data || response) as WithParts[]
    return Array.isArray(payload) ? payload : []
}

export function buildSearchContext(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    rawMessages: WithParts[],
): SearchContext {
    const transformedMessages = structuredClone(rawMessages) as WithParts[]
    prune(state, logger, config, transformedMessages)

    const rawMessagesById = new Map<string, WithParts>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }

    const summaryByBlockId = new Map<number, CompressSummary>()
    for (const summary of state.compressSummaries || []) {
        summaryByBlockId.set(summary.blockId, summary)
    }

    return {
        transformedMessages,
        rawMessagesById,
        summaryByBlockId,
    }
}

export function resolveBoundaryIds(
    context: SearchContext,
    state: SessionState,
    startId: string,
    endId: string,
): { startReference: BoundaryReference; endReference: BoundaryReference } {
    const lookup = buildBoundaryReferenceLookup(context, state)
    const issues: string[] = []
    const parsedStartId = parseBoundaryId(startId)
    const parsedEndId = parseBoundaryId(endId)

    if (parsedStartId === null) {
        issues.push("startId is invalid. Use an injected message ID (mNNNN) or block ID (bN).")
    }

    if (parsedEndId === null) {
        issues.push("endId is invalid. Use an injected message ID (mNNNN) or block ID (bN).")
    }

    if (issues.length > 0) {
        throwCombinedIssues(issues)
    }

    if (!parsedStartId || !parsedEndId) {
        throw new Error("Invalid boundary ID(s)")
    }

    const startReference = lookup.get(parsedStartId.ref)
    const endReference = lookup.get(parsedEndId.ref)

    if (!startReference) {
        issues.push(
            `startId ${parsedStartId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (!endReference) {
        issues.push(
            `endId ${parsedEndId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (issues.length > 0) {
        throwCombinedIssues(issues)
    }

    if (!startReference || !endReference) {
        throw new Error("Failed to resolve boundary IDs")
    }

    if (startReference.transformedIndex > endReference.transformedIndex) {
        throw new Error(
            `startId ${parsedStartId.ref} appears after endId ${parsedEndId.ref} in the conversation. Start must come before end.`,
        )
    }

    return { startReference, endReference }
}

function buildBoundaryReferenceLookup(
    context: SearchContext,
    state: SessionState,
): Map<string, BoundaryReference> {
    const lookup = new Map<string, BoundaryReference>()

    for (let index = 0; index < context.transformedMessages.length; index++) {
        const message = context.transformedMessages[index]
        if (!message) {
            continue
        }
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }

        const text = buildSearchableMessageText(message)
        const reference = resolveBoundaryReference(
            message,
            index,
            text,
            context.summaryByBlockId,
            context.rawMessagesById.has(message.info.id),
        )

        if (reference.kind === "compressed-block") {
            if (reference.blockId === undefined) {
                continue
            }
            const blockRef = formatBlockRef(reference.blockId)
            if (!lookup.has(blockRef)) {
                lookup.set(blockRef, reference)
            }
            continue
        }

        if (!reference.messageId) {
            continue
        }
        const messageRef = state.messageIds.byRawId.get(reference.messageId)
        if (!messageRef) {
            continue
        }

        if (!lookup.has(messageRef)) {
            lookup.set(messageRef, reference)
        }
    }

    return lookup
}

export function resolveRange(
    context: SearchContext,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): RangeResolution {
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const requiredBlockIds: number[] = []
    const requiredBlockSeen = new Set<number>()
    const messageTokenById = new Map<string, number>()

    for (
        let index = startReference.transformedIndex;
        index <= endReference.transformedIndex;
        index++
    ) {
        const message = context.transformedMessages[index]
        if (!message) {
            continue
        }
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }

        const text = buildSearchableMessageText(message)
        const reference = resolveBoundaryReference(
            message,
            index,
            text,
            context.summaryByBlockId,
            context.rawMessagesById.has(message.info.id),
        )

        if (reference.kind === "compressed-block") {
            if (reference.blockId !== undefined && !requiredBlockSeen.has(reference.blockId)) {
                requiredBlockSeen.add(reference.blockId)
                requiredBlockIds.push(reference.blockId)
            }
            continue
        }

        if (!context.rawMessagesById.has(message.info.id)) {
            continue
        }

        const messageId = message.info.id
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
        }

        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage) {
            continue
        }

        if (!messageTokenById.has(messageId)) {
            messageTokenById.set(messageId, countAllMessageTokens(rawMessage))
        }

        const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            if (toolSeen.has(part.callID)) {
                continue
            }
            toolSeen.add(part.callID)
            toolIds.push(part.callID)
        }
    }

    if (messageIds.length === 0) {
        throw new Error(
            "Failed to map boundary matches back to raw messages. Choose boundaries that include original conversation messages.",
        )
    }

    return {
        startReference,
        endReference,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds,
    }
}

export function resolveAnchorMessageId(startReference: BoundaryReference): string {
    if (startReference.kind === "compressed-block") {
        if (!startReference.anchorMessageId) {
            throw new Error("Failed to map boundary matches back to raw messages")
        }
        return startReference.anchorMessageId
    }

    if (!startReference.messageId) {
        throw new Error("Failed to map boundary matches back to raw messages")
    }
    return startReference.messageId
}

export function parseBlockPlaceholders(summary: string): ParsedBlockPlaceholder[] {
    const placeholders: ParsedBlockPlaceholder[] = []
    const regex = new RegExp(BLOCK_PLACEHOLDER_REGEX)

    let match: RegExpExecArray | null
    while ((match = regex.exec(summary)) !== null) {
        const full = match[0]
        const parsed = Number.parseInt(match[1], 10)
        if (!Number.isInteger(parsed)) {
            continue
        }

        placeholders.push({
            raw: full,
            blockId: parsed,
            startIndex: match.index,
            endIndex: match.index + full.length,
        })
    }

    return placeholders
}

export function validateSummaryPlaceholders(
    placeholders: ParsedBlockPlaceholder[],
    requiredBlockIds: number[],
    startReference: BoundaryReference,
    endReference: BoundaryReference,
    summaryByBlockId: Map<number, CompressSummary>,
): void {
    const issues: string[] = []

    const boundaryOptionalIds = new Set<number>()
    if (startReference.kind === "compressed-block") {
        if (startReference.blockId === undefined) {
            issues.push("Failed to map boundary matches back to raw messages")
        } else {
            boundaryOptionalIds.add(startReference.blockId)
        }
    }
    if (endReference.kind === "compressed-block") {
        if (endReference.blockId === undefined) {
            issues.push("Failed to map boundary matches back to raw messages")
        } else {
            boundaryOptionalIds.add(endReference.blockId)
        }
    }

    const strictRequiredIds = requiredBlockIds.filter((id) => !boundaryOptionalIds.has(id))
    const requiredSet = new Set(requiredBlockIds)
    const placeholderIds = placeholders.map((p) => p.blockId)
    const placeholderSet = new Set<number>()
    const duplicateIds = new Set<number>()

    for (const id of placeholderIds) {
        if (placeholderSet.has(id)) {
            duplicateIds.add(id)
            continue
        }
        placeholderSet.add(id)
    }

    const missing = strictRequiredIds.filter((id) => !placeholderSet.has(id))
    if (missing.length > 0) {
        issues.push(
            `Missing required block placeholders: ${missing.map(formatBlockPlaceholder).join(", ")}`,
        )
    }

    const unknown = placeholderIds.filter((id) => !summaryByBlockId.has(id))
    if (unknown.length > 0) {
        const uniqueUnknown = [...new Set(unknown)]
        issues.push(
            `Unknown block placeholders: ${uniqueUnknown.map(formatBlockPlaceholder).join(", ")}`,
        )
    }

    const invalid = placeholderIds.filter((id) => !requiredSet.has(id))
    if (invalid.length > 0) {
        const uniqueInvalid = [...new Set(invalid)]
        issues.push(
            `Invalid block placeholders for selected range: ${uniqueInvalid.map(formatBlockPlaceholder).join(", ")}`,
        )
    }

    if (duplicateIds.size > 0) {
        issues.push(
            `Duplicate block placeholders are not allowed: ${[...duplicateIds].map(formatBlockPlaceholder).join(", ")}`,
        )
    }

    if (issues.length > 0) {
        throwCombinedIssues(issues)
    }
}

export function injectBlockPlaceholders(
    summary: string,
    placeholders: ParsedBlockPlaceholder[],
    summaryByBlockId: Map<number, CompressSummary>,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): InjectedSummaryResult {
    let cursor = 0
    let expanded = summary
    const consumed: number[] = []
    const consumedSeen = new Set<number>()

    if (placeholders.length > 0) {
        expanded = ""
        for (const placeholder of placeholders) {
            const target = summaryByBlockId.get(placeholder.blockId)
            if (!target) {
                throw new Error(
                    `Compressed block not found: ${formatBlockPlaceholder(placeholder.blockId)}`,
                )
            }

            expanded += summary.slice(cursor, placeholder.startIndex)
            expanded += stripCompressedBlockHeader(target.summary)
            cursor = placeholder.endIndex

            if (!consumedSeen.has(placeholder.blockId)) {
                consumedSeen.add(placeholder.blockId)
                consumed.push(placeholder.blockId)
            }
        }

        expanded += summary.slice(cursor)
    }

    expanded = injectBoundarySummaryIfMissing(
        expanded,
        startReference,
        "start",
        summaryByBlockId,
        consumed,
        consumedSeen,
    )
    expanded = injectBoundarySummaryIfMissing(
        expanded,
        endReference,
        "end",
        summaryByBlockId,
        consumed,
        consumedSeen,
    )

    return {
        expandedSummary: expanded,
        consumedBlockIds: consumed,
    }
}

export function allocateBlockId(summaries: CompressSummary[]): number {
    if (summaries.length === 0) {
        return 1
    }

    let max = 0
    for (const summary of summaries) {
        if (summary.blockId > max) {
            max = summary.blockId
        }
    }
    return max + 1
}

export function addCompressedBlockHeader(blockId: number, summary: string): string {
    const header = formatCompressedBlockHeader(blockId)
    const body = summary.trim()
    if (body.length === 0) {
        return header
    }
    return `${header}\n${body}`
}

export function applyCompressionState(
    state: SessionState,
    range: RangeResolution,
    anchorMessageId: string,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
): AppliedCompressionResult {
    const consumed = new Set(consumedBlockIds)
    state.compressSummaries = (state.compressSummaries || []).filter(
        (s) => !consumed.has(s.blockId),
    )
    state.compressSummaries.push({
        blockId,
        anchorMessageId,
        summary,
    })

    let compressedTokens = 0
    for (const messageId of range.messageIds) {
        if (state.prune.messages.has(messageId)) {
            continue
        }

        const tokenCount = range.messageTokenById.get(messageId) || 0
        state.prune.messages.set(messageId, tokenCount)
        compressedTokens += tokenCount
    }

    state.stats.pruneTokenCounter += compressedTokens
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0

    return {
        compressedTokens,
        messageIds: range.messageIds,
    }
}

export function countSummaryTokens(summary: string): number {
    return countTokens(summary)
}

function resolveBoundaryReference(
    message: WithParts,
    transformedIndex: number,
    searchableText: string,
    summaryByBlockId: Map<number, CompressSummary>,
    isRawMessage: boolean,
): BoundaryReference {
    const leadingBlockId = extractLeadingBlockId(searchableText)
    if (!isRawMessage && leadingBlockId !== null) {
        const blockSummary = summaryByBlockId.get(leadingBlockId)
        if (blockSummary) {
            return {
                kind: "compressed-block",
                transformedIndex,
                blockId: leadingBlockId,
                anchorMessageId: blockSummary.anchorMessageId,
            }
        }
    }

    return {
        kind: "message",
        transformedIndex,
        messageId: message.info.id,
    }
}

function buildSearchableMessageText(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    let content = ""

    for (const part of parts) {
        const p = part as Record<string, unknown>
        if ((part as any).ignored) {
            continue
        }

        switch (part.type) {
            case "text":
                if (typeof p.text === "string") {
                    content += ` ${p.text}`
                }
                break

            case "tool": {
                if ((part as any).tool === "compress") {
                    break
                }

                const state = p.state as Record<string, unknown> | undefined
                if (!state) break

                if (state.status === "completed" && state.output !== undefined) {
                    content +=
                        " " +
                        (typeof state.output === "string"
                            ? state.output
                            : JSON.stringify(state.output))
                } else if (state.status === "error" && state.error !== undefined) {
                    content +=
                        " " +
                        (typeof state.error === "string"
                            ? state.error
                            : JSON.stringify(state.error))
                }

                if (state.input !== undefined) {
                    content +=
                        " " +
                        (typeof state.input === "string"
                            ? state.input
                            : JSON.stringify(state.input))
                }
                break
            }

            case "compaction":
                if (typeof p.summary === "string") {
                    content += ` ${p.summary}`
                }
                break

            case "subtask":
                if (typeof p.summary === "string") {
                    content += ` ${p.summary}`
                }
                if (typeof p.result === "string") {
                    content += ` ${p.result}`
                }
                break

            default:
                break
        }
    }

    return content
}

function extractLeadingBlockId(text: string): number | null {
    const match = text.match(COMPRESSED_BLOCK_HEADER_PREFIX_REGEX)
    if (!match) {
        return null
    }
    const id = Number.parseInt(match[1], 10)
    return Number.isInteger(id) ? id : null
}

function stripCompressedBlockHeader(summary: string): string {
    const headerMatch = summary.match(/^\s*\[Compressed conversation b\d+\]/i)
    if (!headerMatch) {
        return summary
    }

    const afterHeader = summary.slice(headerMatch[0].length)
    return afterHeader.replace(/^(?:\r?\n)+/, "")
}

function injectBoundarySummaryIfMissing(
    summary: string,
    reference: BoundaryReference,
    position: "start" | "end",
    summaryByBlockId: Map<number, CompressSummary>,
    consumed: number[],
    consumedSeen: Set<number>,
): string {
    if (reference.kind !== "compressed-block" || reference.blockId === undefined) {
        return summary
    }
    if (consumedSeen.has(reference.blockId)) {
        return summary
    }

    const target = summaryByBlockId.get(reference.blockId)
    if (!target) {
        throw new Error(`Compressed block not found: ${formatBlockPlaceholder(reference.blockId)}`)
    }

    const injectedBody = stripCompressedBlockHeader(target.summary)
    const next =
        position === "start"
            ? mergeWithSpacing(injectedBody, summary)
            : mergeWithSpacing(summary, injectedBody)

    consumedSeen.add(reference.blockId)
    consumed.push(reference.blockId)
    return next
}

function mergeWithSpacing(left: string, right: string): string {
    const l = left.trim()
    const r = right.trim()

    if (!l) {
        return right
    }
    if (!r) {
        return left
    }
    return `${l}\n\n${r}`
}

function throwCombinedIssues(issues: string[]): never {
    if (issues.length === 1) {
        throw new Error(issues[0])
    }

    throw new Error(issues.map((issue) => `- ${issue}`).join("\n"))
}
