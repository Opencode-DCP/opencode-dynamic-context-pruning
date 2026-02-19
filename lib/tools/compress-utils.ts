import type { SessionState, WithParts, CompressSummary } from "../state"
import { formatBlockRef, formatMessageIdTag, parseBoundaryId } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/utils"
import { countAllMessageTokens, countTokens } from "../strategies/utils"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

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
    rawIndex: number
    messageId?: string
    blockId?: number
    anchorMessageId?: string
}

export interface SearchContext {
    rawMessages: WithParts[]
    rawMessagesById: Map<string, WithParts>
    rawIndexById: Map<string, number>
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
    return "[Compressed conversation section]"
}

export function formatCompressedBlockFooter(blockId: number): string {
    return formatMessageIdTag(formatBlockRef(blockId))
}

export function formatBlockPlaceholder(blockId: number): string {
    return `(b${blockId})`
}

export function validateCompressArgs(args: CompressToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (typeof args.content?.startId !== "string" || args.content.startId.trim().length === 0) {
        throw new Error("content.startId is required and must be a non-empty string")
    }

    if (typeof args.content?.endId !== "string" || args.content.endId.trim().length === 0) {
        throw new Error("content.endId is required and must be a non-empty string")
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

export function buildSearchContext(state: SessionState, rawMessages: WithParts[]): SearchContext {
    const rawMessagesById = new Map<string, WithParts>()
    const rawIndexById = new Map<string, number>()
    for (const msg of rawMessages) {
        rawMessagesById.set(msg.info.id, msg)
    }
    for (let index = 0; index < rawMessages.length; index++) {
        const message = rawMessages[index]
        if (!message) {
            continue
        }
        rawIndexById.set(message.info.id, index)
    }

    const summaryByBlockId = new Map<number, CompressSummary>()
    for (const summary of state.compressSummaries || []) {
        summaryByBlockId.set(summary.blockId, summary)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
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

    if (startReference.rawIndex > endReference.rawIndex) {
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

    for (const [messageRef, messageId] of state.messageIds.byRef) {
        const rawMessage = context.rawMessagesById.get(messageId)
        if (!rawMessage) {
            continue
        }
        if (rawMessage.info.role === "user" && isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(messageId)
        if (rawIndex === undefined) {
            continue
        }
        lookup.set(messageRef, {
            kind: "message",
            rawIndex,
            messageId,
        })
    }

    const summaries = Array.from(context.summaryByBlockId.values()).sort(
        (a, b) => a.blockId - b.blockId,
    )
    for (const summary of summaries) {
        const anchorMessage = context.rawMessagesById.get(summary.anchorMessageId)
        if (!anchorMessage) {
            continue
        }
        if (anchorMessage.info.role === "user" && isIgnoredUserMessage(anchorMessage)) {
            continue
        }

        const rawIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (rawIndex === undefined) {
            continue
        }
        const blockRef = formatBlockRef(summary.blockId)
        if (!lookup.has(blockRef)) {
            lookup.set(blockRef, {
                kind: "compressed-block",
                rawIndex,
                blockId: summary.blockId,
                anchorMessageId: summary.anchorMessageId,
            })
        }
    }

    return lookup
}

export function resolveRange(
    context: SearchContext,
    startReference: BoundaryReference,
    endReference: BoundaryReference,
): RangeResolution {
    const startRawIndex = startReference.rawIndex
    const endRawIndex = endReference.rawIndex
    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const requiredBlockIds: number[] = []
    const requiredBlockSeen = new Set<number>()
    const messageTokenById = new Map<string, number>()

    for (let index = startRawIndex; index <= endRawIndex; index++) {
        const rawMessage = context.rawMessages[index]
        if (!rawMessage) {
            continue
        }
        if (rawMessage.info.role === "user" && isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        if (!messageSeen.has(messageId)) {
            messageSeen.add(messageId)
            messageIds.push(messageId)
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

    const rangeMessageIdSet = new Set(messageIds)
    const summariesInRange: Array<{ blockId: number; rawIndex: number }> = []
    for (const summary of context.summaryByBlockId.values()) {
        if (!rangeMessageIdSet.has(summary.anchorMessageId)) {
            continue
        }

        const anchorIndex = context.rawIndexById.get(summary.anchorMessageId)
        if (anchorIndex === undefined) {
            continue
        }

        summariesInRange.push({
            blockId: summary.blockId,
            rawIndex: anchorIndex,
        })
    }

    summariesInRange.sort((a, b) => a.rawIndex - b.rawIndex || a.blockId - b.blockId)
    for (const summary of summariesInRange) {
        if (requiredBlockSeen.has(summary.blockId)) {
            continue
        }
        requiredBlockSeen.add(summary.blockId)
        requiredBlockIds.push(summary.blockId)
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
        const blockIdPart = match[1] || match[2]
        const parsed = Number.parseInt(blockIdPart, 10)
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
            expanded += restoreStoredCompressedSummary(target.summary)
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

export function wrapCompressedSummary(blockId: number, summary: string): string {
    const header = formatCompressedBlockHeader(blockId)
    const footer = formatCompressedBlockFooter(blockId)
    const body = summary.trim()
    if (body.length === 0) {
        return `${header}\n${footer}`
    }
    return `${header}\n${body}\n\n${footer}`
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

function restoreStoredCompressedSummary(summary: string): string {
    const headerMatch = summary.match(/^\s*\[Compressed conversation(?: section)?(?: b\d+)?\]/i)
    if (!headerMatch) {
        return summary
    }

    const afterHeader = summary.slice(headerMatch[0].length)
    const withoutLeadingBreaks = afterHeader.replace(/^(?:\r?\n)+/, "")
    return withoutLeadingBreaks
        .replace(/(?:\r?\n)*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
        .replace(/(?:\r?\n)+$/, "")
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

    const injectedBody = restoreStoredCompressedSummary(target.summary)
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
