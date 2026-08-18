import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"

function sortBlocksByCreation(
    a: { createdAt: number; blockId: number },
    b: { createdAt: number; blockId: number },
): number {
    const createdAtDiff = a.createdAt - b.createdAt
    if (createdAtDiff !== 0) {
        return createdAtDiff
    }
    return a.blockId - b.blockId
}

export const syncCompressionBlocks = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void => {
    const messagesState = state.prune.messages
    if (!messagesState?.blocksById?.size) {
        return
    }

    const messageIds = new Set(messages.map((msg) => msg.info.id))
    const previousActiveBlockIds = new Set<number>(
        Array.from(messagesState.blocksById.values())
            .filter((block) => block.active)
            .map((block) => block.blockId),
    )

    messagesState.activeBlockIds.clear()
    messagesState.activeByAnchorMessageId.clear()

    const now = Date.now()
    const missingOriginBlockIds: number[] = []
    const orderedBlocks = Array.from(messagesState.blocksById.values()).sort(sortBlocksByCreation)

    for (const block of orderedBlocks) {
        const hasOriginMessage =
            typeof block.compressMessageId === "string" &&
            block.compressMessageId.length > 0 &&
            messageIds.has(block.compressMessageId)

        if (!hasOriginMessage) {
            // compressMessageId（执行压缩的 assistant 消息）可能因被 DCP 标记为
            // ignored/synthetic 而从未持久化，重启后会缺失。此时只要锚点消息仍在，
            // 压缩摘要依然有效，应保留 active 使摘要继续注入 LLM 上下文；
            // 否则每次重启压缩都会失效，上下文重新膨胀导致频繁触发压缩提醒。
            const hasAnchorMessage =
                typeof block.anchorMessageId === "string" &&
                block.anchorMessageId.length > 0 &&
                messageIds.has(block.anchorMessageId)

            if (!hasAnchorMessage) {
                block.active = false
                block.deactivatedAt = now
                block.deactivatedByBlockId = undefined
                missingOriginBlockIds.push(block.blockId)
                continue
            }

            block.active = true
            block.deactivatedAt = undefined
            block.deactivatedByBlockId = undefined
            messagesState.activeBlockIds.add(block.blockId)
            messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
            logger.warn("Compress block origin message missing; keeping active via anchor", {
                blockId: block.blockId,
            })
            continue
        }

        if (block.deactivatedByUser) {
            block.active = false
            if (block.deactivatedAt === undefined) {
                block.deactivatedAt = now
            }
            block.deactivatedByBlockId = undefined
            continue
        }

        for (const consumedBlockId of block.consumedBlockIds) {
            if (!messagesState.activeBlockIds.has(consumedBlockId)) {
                continue
            }

            const consumedBlock = messagesState.blocksById.get(consumedBlockId)
            if (consumedBlock) {
                consumedBlock.active = false
                consumedBlock.deactivatedAt = now
                consumedBlock.deactivatedByBlockId = block.blockId

                const mappedBlockId = messagesState.activeByAnchorMessageId.get(
                    consumedBlock.anchorMessageId,
                )
                if (mappedBlockId === consumedBlock.blockId) {
                    messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId)
                }
            }

            messagesState.activeBlockIds.delete(consumedBlockId)
        }

        block.active = true
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
        messagesState.activeBlockIds.add(block.blockId)
        if (messageIds.has(block.anchorMessageId)) {
            messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId)
        }
    }

    for (const entry of messagesState.byMessageId.values()) {
        const allBlockIds = Array.isArray(entry.allBlockIds)
            ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
            : []

        entry.allBlockIds = allBlockIds
        entry.activeBlockIds = allBlockIds.filter((id) => messagesState.activeBlockIds.has(id))
    }

    const nextActiveBlockIds = messagesState.activeBlockIds
    let deactivatedCount = 0
    let reactivatedCount = 0

    for (const blockId of previousActiveBlockIds) {
        if (!nextActiveBlockIds.has(blockId)) {
            deactivatedCount++
        }
    }
    for (const blockId of nextActiveBlockIds) {
        if (!previousActiveBlockIds.has(blockId)) {
            reactivatedCount++
        }
    }

    if (missingOriginBlockIds.length > 0 || deactivatedCount > 0 || reactivatedCount > 0) {
        logger.info("Synced compress block state", {
            missingOriginCount: missingOriginBlockIds.length,
            deactivatedCount,
            reactivatedCount,
        })
    }
}
