import type { CompressionBlock, SessionState, WithParts } from "../state"
import { formatBlockRef, formatMessageIdTag, parseBoundaryId } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/utils"
import { countAllMessageTokens } from "../strategies/utils"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"
import {
    buildSubagentResultText,
    getSubAgentId,
    mergeSubagentResult,
} from "../subagents/subagent-results"

const BLOCK_PLACEHOLDER_REGEX = /\(b(\d+)\)|\{block_(\d+)\}/gi

export interface CompressToolArgs {
    topic: string
    content: {
        targetId: string
        summary: string
    }
}

export interface FlatCompressToolArgs {
    topic: string
    targetId: string
    summary: string
}

export function normalizeCompressArgs(args: Record<string, unknown>): CompressToolArgs {
    if ("content" in args && typeof args.content === "object" && args.content !== null) {
        return args as unknown as CompressToolArgs
    }

    return {
        topic: args.topic as string,
        content: {
            targetId: args.targetId as string,
            summary: args.summary as string,
        },
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
    summaryByBlockId: Map<number, CompressionBlock>
}

export interface BlockResolution {
    targetReference: BoundaryReference
    blockId: number
    anchorMessageId: string
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
    newlyCompressedMessageIds: string[]
    newlyCompressedToolIds: string[]
}

export interface CompressionStateInput {
    topic: string
    targetId: string
    compressMessageId: string
}

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

export function formatBlockPlaceholder(blockId: number): string {
    return `(b${blockId})`
}

export function validateCompressArgs(args: CompressToolArgs): void {
    if (typeof args.topic !== "string" || args.topic.trim().length === 0) {
        throw new Error("topic is required and must be a non-empty string")
    }

    if (typeof args.content?.targetId !== "string" || args.content.targetId.trim().length === 0) {
        throw new Error("content.targetId is required and must be a non-empty string")
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

    const summaryByBlockId = new Map<number, CompressionBlock>()
    for (const [blockId, block] of state.prune.messages.blocksById) {
        if (!block.active) {
            continue
        }
        summaryByBlockId.set(blockId, block)
    }

    return {
        rawMessages,
        rawMessagesById,
        rawIndexById,
        summaryByBlockId,
    }
}

function resolveMessageBlockId(state: SessionState, messageId: string): number | null {
    const direct = state.messageIds.blockByRawId.get(messageId)
    if (typeof direct === "number" && Number.isInteger(direct) && direct > 0) {
        return direct
    }

    const entry = state.prune.messages.byMessageId.get(messageId)
    if (!entry) {
        return null
    }

    const blockIds = entry.allBlockIds
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
    if (blockIds.length === 0) {
        return null
    }

    return blockIds[0] || null
}

export function resolveTargetId(
    context: SearchContext,
    state: SessionState,
    targetId: string,
): BoundaryReference {
    const lookup = buildBoundaryReferenceLookup(context, state)
    const issues: string[] = []
    const parsedTargetId = parseBoundaryId(targetId)

    if (parsedTargetId === null) {
        issues.push(
            "targetId is invalid. Use an injected block-scoped message ID (bNmNNNN) or block ID (bN).",
        )
    }

    if (issues.length > 0) {
        throwCombinedIssues(issues)
    }

    if (!parsedTargetId) {
        throw new Error("Invalid target ID")
    }

    const targetReference = lookup.get(parsedTargetId.ref)

    if (!targetReference) {
        issues.push(
            `targetId ${parsedTargetId.ref} is not available in the current conversation context. Choose an injected ID visible in context.`,
        )
    }

    if (issues.length > 0) {
        throwCombinedIssues(issues)
    }

    if (!targetReference) {
        throw new Error("Failed to resolve target ID")
    }

    if (targetReference.kind === "compressed-block") {
        throw new Error(
            `targetId ${parsedTargetId.ref} refers to an existing compressed block. Choose a visible raw message ID from the block you want to compress.`,
        )
    }

    const blockId = targetReference.blockId || parsedTargetId.blockId
    if (!blockId) {
        throw new Error(
            `targetId ${parsedTargetId.ref} does not include a block ID. Choose an injected block-scoped message ID like b${state.prune.messages.currentBlockId}m0001.`,
        )
    }

    return {
        ...targetReference,
        blockId,
    }
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
            blockId: resolveMessageBlockId(state, messageId) || undefined,
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

export function resolveBlock(
    context: SearchContext,
    state: SessionState,
    targetReference: BoundaryReference,
): BlockResolution {
    if (
        targetReference.kind !== "message" ||
        !targetReference.messageId ||
        !targetReference.blockId
    ) {
        throw new Error("Failed to resolve target block from raw messages")
    }

    const messageIds: string[] = []
    const messageSeen = new Set<string>()
    const toolIds: string[] = []
    const toolSeen = new Set<string>()
    const messageTokenById = new Map<string, number>()
    let anchorMessageId = ""

    for (const rawMessage of context.rawMessages) {
        if (rawMessage.info.role === "user" && isIgnoredUserMessage(rawMessage)) {
            continue
        }

        const messageId = rawMessage.info.id
        if (resolveMessageBlockId(state, messageId) !== targetReference.blockId) {
            continue
        }

        if (!anchorMessageId) {
            anchorMessageId = messageId
        }

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

    if (messageIds.length === 0) {
        throw new Error(
            "Failed to map target block back to raw messages. Choose a visible raw message ID from the block you want to compress.",
        )
    }

    return {
        targetReference,
        blockId: targetReference.blockId,
        anchorMessageId,
        messageIds,
        messageTokenById,
        toolIds,
        requiredBlockIds: [],
    }
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
    summaryByBlockId: Map<number, CompressionBlock>,
): number[] {
    const requiredSet = new Set(requiredBlockIds)
    const keptPlaceholderIds = new Set<number>()
    const validPlaceholders: ParsedBlockPlaceholder[] = []

    for (const placeholder of placeholders) {
        const isKnown = summaryByBlockId.has(placeholder.blockId)
        const isRequired = requiredSet.has(placeholder.blockId)
        const isDuplicate = keptPlaceholderIds.has(placeholder.blockId)

        if (isKnown && isRequired && !isDuplicate) {
            validPlaceholders.push(placeholder)
            keptPlaceholderIds.add(placeholder.blockId)
        }
    }

    placeholders.length = 0
    placeholders.push(...validPlaceholders)

    return requiredBlockIds.filter((id) => !keptPlaceholderIds.has(id))
}

export function injectBlockPlaceholders(
    summary: string,
    placeholders: ParsedBlockPlaceholder[],
    summaryByBlockId: Map<number, CompressionBlock>,
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
            expanded += restoreSummary(target.summary)
            cursor = placeholder.endIndex

            if (!consumedSeen.has(placeholder.blockId)) {
                consumedSeen.add(placeholder.blockId)
                consumed.push(placeholder.blockId)
            }
        }

        expanded += summary.slice(cursor)
    }

    return {
        expandedSummary: expanded,
        consumedBlockIds: consumed,
    }
}

export function allocateBlockId(state: SessionState): number {
    const current = state.prune.messages.currentBlockId
    if (!Number.isInteger(current) || current < 1) {
        state.prune.messages.currentBlockId = 2
        state.prune.messages.nextBlockId = 3
        return 1
    }

    return current
}

export function wrapCompressedSummary(blockId: number, summary: string): string {
    const header = COMPRESSED_BLOCK_HEADER
    const footer = formatMessageIdTag(formatBlockRef(blockId))
    const body = summary.trim()
    if (body.length === 0) {
        return `${header}\n${footer}`
    }
    return `${header}\n${body}\n\n${footer}`
}

export function applyCompressionState(
    state: SessionState,
    input: CompressionStateInput,
    range: BlockResolution,
    blockId: number,
    summary: string,
    consumedBlockIds: number[],
): AppliedCompressionResult {
    const messagesState = state.prune.messages
    const consumed = [...new Set(consumedBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
    const included = [...consumed]

    const effectiveMessageIds = new Set<string>(range.messageIds)
    const effectiveToolIds = new Set<string>(range.toolIds)

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            effectiveMessageIds.add(messageId)
        }
        for (const toolId of consumedBlock.effectiveToolIds) {
            effectiveToolIds.add(toolId)
        }
    }

    const initiallyActiveMessages = new Set<string>()
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (entry && entry.activeBlockIds.length > 0) {
            initiallyActiveMessages.add(messageId)
        }
    }

    const initiallyActiveToolIds = new Set<string>()
    for (const activeBlockId of messagesState.activeBlockIds) {
        const activeBlock = messagesState.blocksById.get(activeBlockId)
        if (!activeBlock || !activeBlock.active) {
            continue
        }

        for (const toolId of activeBlock.effectiveToolIds) {
            initiallyActiveToolIds.add(toolId)
        }
    }

    const createdAt = Date.now()
    const block: CompressionBlock = {
        blockId,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 0,
        topic: input.topic,
        targetId: input.targetId,
        anchorMessageId: range.anchorMessageId,
        compressMessageId: input.compressMessageId,
        includedBlockIds: included,
        consumedBlockIds: consumed,
        parentBlockIds: [],
        directMessageIds: [],
        directToolIds: [],
        effectiveMessageIds: [...effectiveMessageIds],
        effectiveToolIds: [...effectiveToolIds],
        createdAt,
        summary,
    }

    messagesState.blocksById.set(blockId, block)
    messagesState.activeBlockIds.add(blockId)
    messagesState.activeByAnchorMessageId.set(range.anchorMessageId, blockId)

    const deactivatedAt = Date.now()
    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock || !consumedBlock.active) {
            continue
        }

        consumedBlock.active = false
        consumedBlock.deactivatedAt = deactivatedAt
        consumedBlock.deactivatedByBlockId = blockId
        if (!consumedBlock.parentBlockIds.includes(blockId)) {
            consumedBlock.parentBlockIds.push(blockId)
        }

        messagesState.activeBlockIds.delete(consumedBlockId)
        const mappedBlockId = messagesState.activeByAnchorMessageId.get(
            consumedBlock.anchorMessageId,
        )
        if (mappedBlockId === consumedBlockId) {
            messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
        }
    }

    const removeActiveBlockId = (
        entry: { activeBlockIds: number[] },
        blockIdToRemove: number,
    ): void => {
        if (entry.activeBlockIds.length === 0) {
            return
        }
        entry.activeBlockIds = entry.activeBlockIds.filter((id) => id !== blockIdToRemove)
    }

    for (const consumedBlockId of consumed) {
        const consumedBlock = messagesState.blocksById.get(consumedBlockId)
        if (!consumedBlock) {
            continue
        }
        for (const messageId of consumedBlock.effectiveMessageIds) {
            const entry = messagesState.byMessageId.get(messageId)
            if (!entry) {
                continue
            }
            removeActiveBlockId(entry, consumedBlockId)
        }
    }

    for (const messageId of range.messageIds) {
        const tokenCount = range.messageTokenById.get(messageId) || 0
        const existing = messagesState.byMessageId.get(messageId)

        if (!existing) {
            messagesState.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds: [blockId],
                activeBlockIds: [blockId],
            })
            continue
        }

        existing.tokenCount = Math.max(existing.tokenCount, tokenCount)
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    for (const messageId of block.effectiveMessageIds) {
        if (range.messageTokenById.has(messageId)) {
            continue
        }

        const existing = messagesState.byMessageId.get(messageId)
        if (!existing) {
            continue
        }
        if (!existing.allBlockIds.includes(blockId)) {
            existing.allBlockIds.push(blockId)
        }
        if (!existing.activeBlockIds.includes(blockId)) {
            existing.activeBlockIds.push(blockId)
        }
    }

    let compressedTokens = 0
    const newlyCompressedMessageIds: string[] = []
    for (const messageId of effectiveMessageIds) {
        const entry = messagesState.byMessageId.get(messageId)
        if (!entry) {
            continue
        }

        const isNowActive = entry.activeBlockIds.length > 0
        const wasActive = initiallyActiveMessages.has(messageId)

        if (isNowActive && !wasActive) {
            compressedTokens += entry.tokenCount
            newlyCompressedMessageIds.push(messageId)
        }
    }

    const newlyCompressedToolIds: string[] = []
    for (const toolId of effectiveToolIds) {
        if (!initiallyActiveToolIds.has(toolId)) {
            newlyCompressedToolIds.push(toolId)
        }
    }

    block.directMessageIds = [...newlyCompressedMessageIds]
    block.directToolIds = [...newlyCompressedToolIds]

    block.compressedTokens = compressedTokens

    state.stats.pruneTokenCounter += compressedTokens
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0

    return {
        compressedTokens,
        messageIds: range.messageIds,
        newlyCompressedMessageIds,
        newlyCompressedToolIds,
    }
}

function restoreSummary(summary: string): string {
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

export function appendProtectedUserMessages(
    summary: string,
    range: BlockResolution,
    searchContext: SearchContext,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const userTexts: string[] = []

    for (const messageId of range.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue
        if (message.info.role !== "user") continue
        if (isIgnoredUserMessage(message)) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                userTexts.push(part.text)
                break
            }
        }
    }

    if (userTexts.length === 0) {
        return summary
    }

    const heading = "\n\nThe following user messages were sent in this conversation verbatim:"
    const body = userTexts.map((text) => `\n${text}`).join("")
    return summary + heading + body
}

export async function appendProtectedTools(
    client: any,
    state: SessionState,
    allowSubAgents: boolean,
    summary: string,
    range: BlockResolution,
    searchContext: SearchContext,
    protectedTools: string[],
    protectedFilePatterns: string[] = [],
): Promise<string> {
    const protectedOutputs: string[] = []

    for (const messageId of range.messageIds) {
        const existingCompressionEntry = state.prune.messages.byMessageId.get(messageId)
        if (existingCompressionEntry && existingCompressionEntry.activeBlockIds.length > 0) {
            continue
        }

        const message = searchContext.rawMessagesById.get(messageId)
        if (!message) continue

        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                let isToolProtected = isToolNameProtected(part.tool, protectedTools)

                if (!isToolProtected && protectedFilePatterns.length > 0) {
                    const filePaths = getFilePathsFromParameters(part.tool, part.state?.input)
                    if (isFilePathProtected(filePaths, protectedFilePatterns)) {
                        isToolProtected = true
                    }
                }

                if (isToolProtected) {
                    const title = `Tool: ${part.tool}`
                    let output = ""

                    if (part.state?.status === "completed" && part.state?.output) {
                        output =
                            typeof part.state.output === "string"
                                ? part.state.output
                                : JSON.stringify(part.state.output)
                    }

                    if (
                        allowSubAgents &&
                        part.tool === "task" &&
                        part.state?.status === "completed" &&
                        typeof part.state?.output === "string"
                    ) {
                        const cachedSubAgentResult = state.subAgentResultCache.get(part.callID)

                        if (cachedSubAgentResult !== undefined) {
                            if (cachedSubAgentResult) {
                                output = mergeSubagentResult(
                                    part.state.output,
                                    cachedSubAgentResult,
                                )
                            }
                        } else {
                            const subAgentSessionId = getSubAgentId(part)
                            if (subAgentSessionId) {
                                let subAgentResultText = ""
                                try {
                                    const subAgentMessages = await fetchSessionMessages(
                                        client,
                                        subAgentSessionId,
                                    )
                                    subAgentResultText = buildSubagentResultText(subAgentMessages)
                                } catch {
                                    subAgentResultText = ""
                                }

                                if (subAgentResultText) {
                                    state.subAgentResultCache.set(part.callID, subAgentResultText)
                                    output = mergeSubagentResult(
                                        part.state.output,
                                        subAgentResultText,
                                    )
                                }
                            }
                        }
                    }

                    if (output) {
                        protectedOutputs.push(`\n### ${title}\n${output}`)
                    }
                }
            }
        }
    }

    if (protectedOutputs.length === 0) {
        return summary
    }

    const heading = "\n\nThe following protected tools were used in this conversation as well:"
    return summary + heading + protectedOutputs.join("")
}

export function appendMissingBlockSummaries(
    summary: string,
    missingBlockIds: number[],
    summaryByBlockId: Map<number, CompressionBlock>,
    consumedBlockIds: number[],
): InjectedSummaryResult {
    const consumedSeen = new Set<number>(consumedBlockIds)
    const consumed = [...consumedBlockIds]

    const missingSummaries: string[] = []
    for (const blockId of missingBlockIds) {
        if (consumedSeen.has(blockId)) {
            continue
        }

        const target = summaryByBlockId.get(blockId)
        if (!target) {
            throw new Error(`Compressed block not found: ${formatBlockPlaceholder(blockId)}`)
        }

        missingSummaries.push(
            `\n### ${formatBlockPlaceholder(blockId)}\n${restoreSummary(target.summary)}`,
        )
        consumedSeen.add(blockId)
        consumed.push(blockId)
    }

    if (missingSummaries.length === 0) {
        return {
            expandedSummary: summary,
            consumedBlockIds: consumed,
        }
    }

    const heading =
        "\n\nThe following previously compressed summaries were also part of this conversation section:"

    return {
        expandedSummary: summary + heading + missingSummaries.join(""),
        consumedBlockIds: consumed,
    }
}

function throwCombinedIssues(issues: string[]): never {
    if (issues.length === 1) {
        throw new Error(issues[0])
    }

    throw new Error(issues.map((issue) => `- ${issue}`).join("\n"))
}
