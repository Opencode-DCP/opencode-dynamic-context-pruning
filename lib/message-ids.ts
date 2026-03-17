import type { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage } from "./messages/utils"

const MESSAGE_REF_REGEX = /^m(\d{4})$/
const BLOCK_MESSAGE_REF_REGEX = /^b([1-9]\d*)m(\d{4})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
const MESSAGE_ID_TAG_NAME = "dcp-message-id"

const MESSAGE_REF_WIDTH = 4
const MESSAGE_REF_MIN_INDEX = 1
export const MESSAGE_REF_MAX_INDEX = 9999

export interface MessageIdTagMeta {
    priority: string
    tokens: number
}

export type ParsedBoundaryId =
    | {
          kind: "message"
          ref: string
          index: number
          blockId?: number
      }
    | {
          kind: "compressed-block"
          ref: string
          blockId: number
      }

export function formatMessageRef(index: number): string {
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        throw new Error(
            `Message ID index out of bounds: ${index}. Supported range is 0-${MESSAGE_REF_MAX_INDEX}.`,
        )
    }
    return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`
}

export function formatBlockRef(blockId: number): string {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    return `b${blockId}`
}

export function formatBlockMessageRef(blockId: number, index: number): string {
    return `${formatBlockRef(blockId)}${formatMessageRef(index)}`
}

export function parseMessageRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }
    const index = Number.parseInt(match[1], 10)
    if (!Number.isInteger(index)) {
        return null
    }
    if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
        return null
    }
    return index
}

export function parseBlockRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(BLOCK_REF_REGEX)
    if (!match) {
        return null
    }
    const id = Number.parseInt(match[1], 10)
    return Number.isInteger(id) ? id : null
}

export function parseBlockMessageRef(
    ref: string,
): { blockId: number; index: number; ref: string } | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(BLOCK_MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }

    const blockId = Number.parseInt(match[1], 10)
    const index = Number.parseInt(match[2], 10)
    if (!Number.isInteger(blockId) || blockId < 1) {
        return null
    }
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        return null
    }

    return {
        blockId,
        index,
        ref: formatBlockMessageRef(blockId, index),
    }
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const normalized = id.trim().toLowerCase()
    const blockMessage = parseBlockMessageRef(normalized)
    if (blockMessage !== null) {
        return {
            kind: "message",
            ref: blockMessage.ref,
            index: blockMessage.index,
            blockId: blockMessage.blockId,
        }
    }

    const messageIndex = parseMessageRef(normalized)
    if (messageIndex !== null) {
        return {
            kind: "message",
            ref: formatMessageRef(messageIndex),
            index: messageIndex,
        }
    }

    const blockId = parseBlockRef(normalized)
    if (blockId !== null) {
        return {
            kind: "compressed-block",
            ref: formatBlockRef(blockId),
            blockId,
        }
    }

    return null
}

export function formatMessageIdTag(ref: string, meta?: MessageIdTagMeta): string {
    if (!meta) {
        return `\n<${MESSAGE_ID_TAG_NAME}>${ref}</${MESSAGE_ID_TAG_NAME}>`
    }

    const priority = meta.priority.replace(/"/g, "&quot;")
    const tokens = Math.max(0, Math.round(meta.tokens))
    return `\n<${MESSAGE_ID_TAG_NAME} priority="${priority}" tokens="${tokens}">${ref}</${MESSAGE_ID_TAG_NAME}>`
}

export function assignMessageRefs(state: SessionState, messages: WithParts[]): number {
    let assigned = 0
    let skippedSubAgentPrompt = false
    const messagesState = state.prune.messages
    if (!Number.isInteger(messagesState.currentBlockId) || messagesState.currentBlockId < 1) {
        messagesState.currentBlockId = 1
    }
    if (
        !Number.isInteger(messagesState.nextBlockId) ||
        messagesState.nextBlockId <= messagesState.currentBlockId
    ) {
        messagesState.nextBlockId = messagesState.currentBlockId + 1
    }

    for (const block of messagesState.blocksById.values()) {
        for (const messageId of block.directMessageIds) {
            if (!state.messageIds.blockByRawId.has(messageId)) {
                state.messageIds.blockByRawId.set(messageId, block.blockId)
            }
        }
    }

    let lastRole: "user" | "assistant" | "other" | null = null
    let lastBlockId: number | null = null

    for (const message of messages) {
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }

        if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
            skippedSubAgentPrompt = true
            continue
        }

        const rawMessageId = message.info.id
        if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
            continue
        }

        const existingRef = state.messageIds.byRawId.get(rawMessageId)
        if (existingRef) {
            const parsedExisting = parseBlockMessageRef(existingRef)
            if (parsedExisting) {
                state.messageIds.blockByRawId.set(rawMessageId, parsedExisting.blockId)
                syncCurrentBlock(state, parsedExisting.blockId)
                lastBlockId = parsedExisting.blockId
            } else {
                const existingBlockId = state.messageIds.blockByRawId.get(rawMessageId)
                if (existingBlockId) {
                    syncCurrentBlock(state, existingBlockId)
                    lastBlockId = existingBlockId
                }
            }
            if (state.messageIds.byRef.get(existingRef) !== rawMessageId) {
                state.messageIds.byRef.set(existingRef, rawMessageId)
            }
            lastRole = normalizeRole(message.info.role)
            continue
        }

        const blockId = resolveVisibleBlockId(state, message.info.role, lastRole, lastBlockId)
        const suffix = allocateNextMessageRef(state)
        const ref = formatBlockMessageRef(blockId, parseMessageRef(suffix) || MESSAGE_REF_MIN_INDEX)
        state.messageIds.byRawId.set(rawMessageId, ref)
        state.messageIds.byRef.set(ref, rawMessageId)
        state.messageIds.blockByRawId.set(rawMessageId, blockId)
        syncCurrentBlock(state, blockId)
        lastRole = normalizeRole(message.info.role)
        lastBlockId = blockId
        assigned++
    }

    return assigned
}

function resolveVisibleBlockId(
    state: SessionState,
    role: string,
    lastRole: "user" | "assistant" | "other" | null,
    lastBlockId: number | null,
): number {
    const currentRole = normalizeRole(role)
    if (currentRole === "user") {
        if (lastRole === "user" && lastBlockId) {
            return lastBlockId
        }
        return startNewBlock(state)
    }

    if (currentRole === "assistant") {
        if (lastRole === "user" && lastBlockId) {
            return lastBlockId
        }
        return startNewBlock(state)
    }

    if (lastBlockId) {
        return lastBlockId
    }

    return startNewBlock(state)
}

function normalizeRole(role: string): "user" | "assistant" | "other" {
    if (role === "user") {
        return "user"
    }
    if (role === "assistant") {
        return "assistant"
    }
    return "other"
}

function startNewBlock(state: SessionState): number {
    const current = state.prune.messages.currentBlockId
    if (!blockIdInUse(state, current)) {
        syncCurrentBlock(state, current)
        return current
    }

    const blockId = state.prune.messages.nextBlockId
    state.prune.messages.currentBlockId = blockId
    state.prune.messages.nextBlockId = blockId + 1
    return blockId
}

function blockIdInUse(state: SessionState, blockId: number): boolean {
    if (!Number.isInteger(blockId) || blockId < 1) {
        return false
    }
    if (state.prune.messages.blocksById.has(blockId)) {
        return true
    }
    return Array.from(state.messageIds.blockByRawId.values()).some((id) => id === blockId)
}

function syncCurrentBlock(state: SessionState, blockId: number): void {
    if (!Number.isInteger(blockId) || blockId < 1) {
        return
    }
    state.prune.messages.currentBlockId = blockId
    if (state.prune.messages.nextBlockId <= blockId) {
        state.prune.messages.nextBlockId = blockId + 1
    }
}

function allocateNextMessageRef(state: SessionState): string {
    const candidate = Number.isInteger(state.messageIds.nextRef)
        ? Math.max(MESSAGE_REF_MIN_INDEX, state.messageIds.nextRef)
        : MESSAGE_REF_MIN_INDEX

    if (candidate <= MESSAGE_REF_MAX_INDEX) {
        state.messageIds.nextRef = candidate + 1
        return formatMessageRef(candidate)
    }

    throw new Error(
        `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(MESSAGE_REF_MAX_INDEX)} aliases in this session.`,
    )
}
