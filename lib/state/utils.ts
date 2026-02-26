import type {
    CompressionBlock,
    PruneMessagesState,
    PrunedMessageEntry,
    SessionState,
    WithParts,
} from "./types"
import { isMessageCompacted } from "../shared-utils"
import { isIgnoredUserMessage } from "../messages/utils"

interface PersistedPruneMessagesState {
    byMessageId?: Record<string, PrunedMessageEntry>
    blocksById?: Record<string, CompressionBlock>
    activeBlockIds?: number[]
    activeByAnchorMessageId?: Record<string, number>
    nextBlockId?: number
}

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function loadPruneMap(obj?: Record<string, number>): Map<string, number> {
    if (!obj || typeof obj !== "object") {
        return new Map()
    }

    const entries = Object.entries(obj).filter(
        (entry): entry is [string, number] =>
            typeof entry[0] === "string" && typeof entry[1] === "number",
    )
    return new Map(entries)
}

export function createPruneMessagesState(): PruneMessagesState {
    return {
        byMessageId: new Map<string, PrunedMessageEntry>(),
        blocksById: new Map<number, CompressionBlock>(),
        activeBlockIds: new Set<number>(),
        activeByAnchorMessageId: new Map<string, number>(),
        nextBlockId: 1,
    }
}

export function loadPruneMessagesState(
    persisted?: PersistedPruneMessagesState,
): PruneMessagesState {
    const state = createPruneMessagesState()
    if (!persisted || typeof persisted !== "object") {
        return state
    }

    if (typeof persisted.nextBlockId === "number" && Number.isInteger(persisted.nextBlockId)) {
        state.nextBlockId = Math.max(1, persisted.nextBlockId)
    }

    if (persisted.byMessageId && typeof persisted.byMessageId === "object") {
        for (const [messageId, entry] of Object.entries(persisted.byMessageId)) {
            if (!entry || typeof entry !== "object") {
                continue
            }

            const tokenCount = typeof entry.tokenCount === "number" ? entry.tokenCount : 0
            const allBlockIds = Array.isArray(entry.allBlockIds)
                ? [
                      ...new Set(
                          entry.allBlockIds.filter(
                              (id): id is number => Number.isInteger(id) && id > 0,
                          ),
                      ),
                  ]
                : []
            const activeBlockIds = Array.isArray(entry.activeBlockIds)
                ? [
                      ...new Set(
                          entry.activeBlockIds.filter(
                              (id): id is number => Number.isInteger(id) && id > 0,
                          ),
                      ),
                  ]
                : []

            state.byMessageId.set(messageId, {
                tokenCount,
                allBlockIds,
                activeBlockIds,
            })
        }
    }

    if (persisted.blocksById && typeof persisted.blocksById === "object") {
        for (const [blockIdStr, block] of Object.entries(persisted.blocksById)) {
            const blockId = Number.parseInt(blockIdStr, 10)
            if (!Number.isInteger(blockId) || blockId < 1 || !block || typeof block !== "object") {
                continue
            }

            const toNumberArray = (value: unknown): number[] =>
                Array.isArray(value)
                    ? [
                          ...new Set(
                              value.filter(
                                  (item): item is number => Number.isInteger(item) && item > 0,
                              ),
                          ),
                      ]
                    : []
            const toStringArray = (value: unknown): string[] =>
                Array.isArray(value)
                    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
                    : []

            state.blocksById.set(blockId, {
                blockId,
                active: block.active === true,
                topic: typeof block.topic === "string" ? block.topic : "",
                startId: typeof block.startId === "string" ? block.startId : "",
                endId: typeof block.endId === "string" ? block.endId : "",
                anchorMessageId:
                    typeof block.anchorMessageId === "string" ? block.anchorMessageId : "",
                compressMessageId:
                    typeof block.compressMessageId === "string" ? block.compressMessageId : "",
                includedBlockIds: toNumberArray(block.includedBlockIds),
                consumedBlockIds: toNumberArray(block.consumedBlockIds),
                parentBlockIds: toNumberArray(block.parentBlockIds),
                directMessageIds: toStringArray(block.directMessageIds),
                directToolIds: toStringArray(block.directToolIds),
                effectiveMessageIds: toStringArray(block.effectiveMessageIds),
                effectiveToolIds: toStringArray(block.effectiveToolIds),
                createdAt: typeof block.createdAt === "number" ? block.createdAt : 0,
                deactivatedAt:
                    typeof block.deactivatedAt === "number" ? block.deactivatedAt : undefined,
                deactivatedByBlockId:
                    typeof block.deactivatedByBlockId === "number" &&
                    Number.isInteger(block.deactivatedByBlockId)
                        ? block.deactivatedByBlockId
                        : undefined,
                summary: typeof block.summary === "string" ? block.summary : "",
            })
        }
    }

    if (Array.isArray(persisted.activeBlockIds)) {
        for (const blockId of persisted.activeBlockIds) {
            if (!Number.isInteger(blockId) || blockId < 1) {
                continue
            }
            state.activeBlockIds.add(blockId)
        }
    }

    if (
        persisted.activeByAnchorMessageId &&
        typeof persisted.activeByAnchorMessageId === "object"
    ) {
        for (const [anchorMessageId, blockId] of Object.entries(
            persisted.activeByAnchorMessageId,
        )) {
            if (typeof blockId !== "number" || !Number.isInteger(blockId) || blockId < 1) {
                continue
            }
            state.activeByAnchorMessageId.set(anchorMessageId, blockId)
        }
    }

    for (const [blockId, block] of state.blocksById) {
        if (block.active) {
            state.activeBlockIds.add(blockId)
            if (block.anchorMessageId) {
                state.activeByAnchorMessageId.set(block.anchorMessageId, blockId)
            }
        }
        if (blockId >= state.nextBlockId) {
            state.nextBlockId = blockId + 1
        }
    }

    return state
}

function hasCompletedCompress(message: WithParts): boolean {
    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

export function collectTurnNudgeAnchors(messages: WithParts[]): Set<string> {
    const anchors = new Set<string>()
    let pendingUserMessageId: string | null = null

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        if (hasCompletedCompress(message)) {
            break
        }

        if (message.info.role === "user") {
            if (!isIgnoredUserMessage(message)) {
                pendingUserMessageId = message.info.id
            }
            continue
        }

        if (message.info.role === "assistant" && pendingUserMessageId) {
            anchors.add(message.info.id)
            anchors.add(pendingUserMessageId)
            pendingUserMessageId = null
        }
    }

    return anchors
}

export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = createPruneMessagesState()
    state.nudges = {
        contextLimitAnchors: new Set<string>(),
        turnNudgeAnchors: new Set<string>(),
        iterationNudgeAnchors: new Set<string>(),
    }
}
