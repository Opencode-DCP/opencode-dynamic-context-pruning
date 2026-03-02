import type { Logger } from "../logger"
import type { CompressionBlock, PruneMessagesState, SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../strategies/utils"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"

export interface RecompressCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

function parseBlockIdArg(arg: string): number | null {
    const normalized = arg.trim().toLowerCase()
    const blockRef = parseBlockRef(normalized)
    if (blockRef !== null) {
        return blockRef
    }

    if (!/^[1-9]\d*$/.test(normalized)) {
        return null
    }

    const parsed = Number.parseInt(normalized, 10)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function getRecompressibleBlocks(
    messagesState: PruneMessagesState,
    availableMessageIds: Set<string>,
): CompressionBlock[] {
    return Array.from(messagesState.blocksById.values())
        .filter(
            (block) =>
                block.deactivatedByUser &&
                !block.active &&
                availableMessageIds.has(block.compressMessageId),
        )
        .sort((a, b) => a.blockId - b.blockId)
}

function snapshotActiveMessages(messagesState: PruneMessagesState): Set<string> {
    const activeMessages = new Set<string>()
    for (const [messageId, entry] of messagesState.byMessageId) {
        if (entry.activeBlockIds.length > 0) {
            activeMessages.add(messageId)
        }
    }
    return activeMessages
}

function formatRecompressMessage(
    targetBlockId: number,
    recompressedMessageCount: number,
    recompressedTokens: number,
    deactivatedBlockIds: number[],
): string {
    const lines: string[] = []

    lines.push(`Re-applied compression ${targetBlockId}.`)
    if (deactivatedBlockIds.length > 0) {
        const refs = deactivatedBlockIds.map((id) => String(id)).join(", ")
        lines.push(`Also re-compressed nested compression(s): ${refs}.`)
    }

    if (recompressedMessageCount > 0) {
        lines.push(
            `Re-compressed ${recompressedMessageCount} message(s) (~${formatTokenCount(recompressedTokens)}).`,
        )
    } else {
        lines.push("No messages were re-compressed.")
    }

    return lines.join("\n")
}

function formatAvailableBlocksMessage(availableBlocks: CompressionBlock[]): string {
    const lines: string[] = []

    lines.push("Usage: /dcp recompress <n>")
    lines.push("")

    if (availableBlocks.length === 0) {
        lines.push("No user-decompressed blocks are available to re-compress.")
        return lines.join("\n")
    }

    lines.push("Available user-decompressed blocks:")
    const entries = availableBlocks.map((block) => {
        const topic = block.topic.replace(/\s+/g, " ").trim() || "(no topic)"
        const label = `${block.blockId} (${formatTokenCount(block.compressedTokens)})`
        return { label, topic }
    })

    const labelWidth = Math.max(...entries.map((entry) => entry.label.length)) + 4
    for (const entry of entries) {
        lines.push(`  ${entry.label.padEnd(labelWidth)}${entry.topic}`)
    }

    return lines.join("\n")
}

export async function handleRecompressCommand(ctx: RecompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /dcp recompress <n>",
            params,
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages
    const availableMessageIds = new Set(messages.map((msg) => msg.info.id))

    if (!targetArg) {
        const availableBlocks = getRecompressibleBlocks(messagesState, availableMessageIds)
        const message = formatAvailableBlocksMessage(availableBlocks)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression number. Example: /dcp recompress 2`,
            params,
            logger,
        )
        return
    }

    const targetBlock = messagesState.blocksById.get(targetBlockId)
    if (!targetBlock) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} does not exist.`,
            params,
            logger,
        )
        return
    }

    if (!availableMessageIds.has(targetBlock.compressMessageId)) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} can no longer be re-applied because its origin message is no longer in this session.`,
            params,
            logger,
        )
        return
    }

    if (!targetBlock.deactivatedByUser) {
        const message = targetBlock.active
            ? `Compression ${targetBlockId} is already active.`
            : `Compression ${targetBlockId} is not user-decompressed.`
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const activeMessagesBefore = snapshotActiveMessages(messagesState)
    const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

    targetBlock.deactivatedByUser = false
    targetBlock.deactivatedAt = undefined
    targetBlock.deactivatedByBlockId = undefined

    syncCompressionBlocks(state, logger, messages)

    let recompressedMessageCount = 0
    let recompressedTokens = 0
    for (const [messageId, entry] of messagesState.byMessageId) {
        const isActiveNow = entry.activeBlockIds.length > 0
        if (isActiveNow && !activeMessagesBefore.has(messageId)) {
            recompressedMessageCount++
            recompressedTokens += entry.tokenCount
        }
    }

    state.stats.totalPruneTokens += recompressedTokens

    const deactivatedBlockIds = Array.from(activeBlockIdsBefore)
        .filter((blockId) => !messagesState.activeBlockIds.has(blockId))
        .sort((a, b) => a - b)

    await saveSessionState(state, logger)

    const message = formatRecompressMessage(
        targetBlockId,
        recompressedMessageCount,
        recompressedTokens,
        deactivatedBlockIds,
    )
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Recompress command completed", {
        targetBlockId,
        recompressedMessageCount,
        recompressedTokens,
        deactivatedBlockIds,
    })
}
