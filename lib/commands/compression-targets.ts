import type { CompressionBlock, PruneMessagesState } from "../state"

export interface CompressionTarget {
    displayId: number
    runId: number
    topic: string
    compressedTokens: number
    grouped: boolean
    blocks: CompressionBlock[]
}

function byBlockId(a: CompressionBlock, b: CompressionBlock): number {
    return a.blockId - b.blockId
}

function buildTarget(blocks: CompressionBlock[]): CompressionTarget {
    const ordered = [...blocks].sort(byBlockId)
    const first = ordered[0]
    if (!first) {
        throw new Error("Cannot build compression target from empty block list.")
    }

    const grouped = first.mode === "message"
    return {
        displayId: first.blockId,
        runId: first.runId,
        topic: grouped ? first.batchTopic || first.topic : first.topic,
        compressedTokens: ordered.reduce((total, block) => total + block.compressedTokens, 0),
        grouped,
        blocks: ordered,
    }
}

function groupMessageBlocks(blocks: CompressionBlock[]): CompressionTarget[] {
    const grouped = new Map<number, CompressionBlock[]>()

    for (const block of blocks) {
        const existing = grouped.get(block.runId)
        if (existing) {
            existing.push(block)
            continue
        }
        grouped.set(block.runId, [block])
    }

    return Array.from(grouped.values()).map(buildTarget)
}

function splitTargets(blocks: CompressionBlock[]): CompressionTarget[] {
    const messageBlocks: CompressionBlock[] = []
    const singleBlocks: CompressionBlock[] = []

    for (const block of blocks) {
        if (block.mode === "message") {
            messageBlocks.push(block)
        } else {
            singleBlocks.push(block)
        }
    }

    const targets = [
        ...singleBlocks.map((block) => buildTarget([block])),
        ...groupMessageBlocks(messageBlocks),
    ]
    return targets.sort((a, b) => a.displayId - b.displayId)
}

export function getActiveCompressionTargets(
    messagesState: PruneMessagesState,
): CompressionTarget[] {
    const activeBlocks = Array.from(messagesState.activeBlockIds)
        .map((blockId) => messagesState.blocksById.get(blockId))
        .filter((block): block is CompressionBlock => !!block && block.active)

    return splitTargets(activeBlocks)
}

export function getRecompressibleCompressionTargets(
    messagesState: PruneMessagesState,
    availableMessageIds: Set<string>,
): CompressionTarget[] {
    const allBlocks = Array.from(messagesState.blocksById.values()).filter((block) => {
        return availableMessageIds.has(block.compressMessageId)
    })

    const messageGroups = new Map<number, CompressionBlock[]>()
    const singleTargets: CompressionTarget[] = []

    for (const block of allBlocks) {
        if (block.mode === "message") {
            const existing = messageGroups.get(block.runId)
            if (existing) {
                existing.push(block)
            } else {
                messageGroups.set(block.runId, [block])
            }
            continue
        }

        if (block.deactivatedByUser && !block.active) {
            singleTargets.push(buildTarget([block]))
        }
    }

    for (const blocks of messageGroups.values()) {
        if (blocks.some((block) => block.deactivatedByUser && !block.active)) {
            singleTargets.push(buildTarget(blocks))
        }
    }

    return singleTargets.sort((a, b) => a.displayId - b.displayId)
}

export function resolveCompressionTarget(
    messagesState: PruneMessagesState,
    blockId: number,
): CompressionTarget | null {
    const block = messagesState.blocksById.get(blockId)
    if (!block) {
        return null
    }

    if (block.mode !== "message") {
        return buildTarget([block])
    }

    const blocks = Array.from(messagesState.blocksById.values()).filter(
        (candidate) => candidate.mode === "message" && candidate.runId === block.runId,
    )
    if (blocks.length === 0) {
        return null
    }

    return buildTarget(blocks)
}
