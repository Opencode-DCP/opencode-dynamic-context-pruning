import type { Logger } from "../logger"
import type { CompressionBlock, PruneMessagesState, SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../strategies/utils"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"

export interface UncompressCommandContext {
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

function getAvailableBlocks(messagesState: PruneMessagesState): CompressionBlock[] {
    return Array.from(messagesState.activeBlockIds)
        .map((blockId) => messagesState.blocksById.get(blockId))
        .filter((block): block is CompressionBlock => !!block && block.active)
        .sort((a, b) => a.blockId - b.blockId)
}

function findActiveParentBlockId(
    messagesState: PruneMessagesState,
    block: CompressionBlock,
): number | null {
    const queue = [...block.parentBlockIds]
    const visited = new Set<number>()

    while (queue.length > 0) {
        const parentBlockId = queue.shift()
        if (parentBlockId === undefined || visited.has(parentBlockId)) {
            continue
        }
        visited.add(parentBlockId)

        const parent = messagesState.blocksById.get(parentBlockId)
        if (!parent) {
            continue
        }

        if (parent.active) {
            return parent.blockId
        }

        for (const ancestorId of parent.parentBlockIds) {
            if (!visited.has(ancestorId)) {
                queue.push(ancestorId)
            }
        }
    }

    return null
}

function snapshotActiveMessages(messagesState: PruneMessagesState): Map<string, number> {
    const activeMessages = new Map<string, number>()
    for (const [messageId, entry] of messagesState.byMessageId) {
        if (entry.activeBlockIds.length > 0) {
            activeMessages.set(messageId, entry.tokenCount)
        }
    }
    return activeMessages
}

function formatUncompressMessage(
    targetBlockId: number,
    restoredMessageCount: number,
    restoredTokens: number,
    reactivatedBlockIds: number[],
): string {
    const lines: string[] = []

    lines.push(`Restored compression ${targetBlockId}.`)
    if (reactivatedBlockIds.length > 0) {
        const refs = reactivatedBlockIds.map((id) => String(id)).join(", ")
        lines.push(`Also restored nested compression(s): ${refs}.`)
    }

    if (restoredMessageCount > 0) {
        lines.push(
            `Restored ${restoredMessageCount} message(s) (~${formatTokenCount(restoredTokens)}).`,
        )
    } else {
        lines.push("No messages were restored.")
    }

    return lines.join("\n")
}

function formatAvailableBlocksMessage(availableBlocks: CompressionBlock[]): string {
    const lines: string[] = []

    lines.push("╭─────────────────────────────────────────────────────────────────────────╮")
    lines.push("│                             DCP Decompress                              │")
    lines.push("╰─────────────────────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Usage:")
    lines.push("  /dcp decompress <n>")
    lines.push("")

    if (availableBlocks.length === 0) {
        lines.push("No compressions are available to restore.")
        return lines.join("\n")
    }

    lines.push("Available compressions:")
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

export async function handleUncompressCommand(ctx: UncompressCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx

    const params = getCurrentParams(state, messages, logger)
    const targetArg = args[0]

    if (args.length > 1) {
        await sendIgnoredMessage(
            client,
            sessionId,
            "Invalid arguments. Usage: /dcp decompress <n>",
            params,
            logger,
        )
        return
    }

    syncCompressionBlocks(state, logger, messages)
    const messagesState = state.prune.messages

    if (!targetArg) {
        const availableBlocks = getAvailableBlocks(messagesState)
        const message = formatAvailableBlocksMessage(availableBlocks)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const targetBlockId = parseBlockIdArg(targetArg)
    if (targetBlockId === null) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Please enter a compression number. Example: /dcp decompress 2`,
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

    if (!targetBlock.active) {
        const activeAncestorBlockId = findActiveParentBlockId(messagesState, targetBlock)
        if (activeAncestorBlockId !== null) {
            await sendIgnoredMessage(
                client,
                sessionId,
                `Compression ${targetBlockId} is inside compression ${activeAncestorBlockId}. Restore compression ${activeAncestorBlockId} first.`,
                params,
                logger,
            )
            return
        }

        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} is not active.`,
            params,
            logger,
        )
        return
    }

    const activeMessagesBefore = snapshotActiveMessages(messagesState)
    const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

    targetBlock.active = false
    targetBlock.deactivatedByUser = true
    targetBlock.deactivatedAt = Date.now()
    targetBlock.deactivatedByBlockId = undefined

    syncCompressionBlocks(state, logger, messages)

    let restoredMessageCount = 0
    let restoredTokens = 0
    for (const [messageId, tokenCount] of activeMessagesBefore) {
        const entry = messagesState.byMessageId.get(messageId)
        const isActiveNow = entry ? entry.activeBlockIds.length > 0 : false
        if (!isActiveNow) {
            restoredMessageCount++
            restoredTokens += tokenCount
        }
    }

    state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens - restoredTokens)

    const reactivatedBlockIds = Array.from(messagesState.activeBlockIds)
        .filter((blockId) => !activeBlockIdsBefore.has(blockId))
        .sort((a, b) => a - b)

    await saveSessionState(state, logger)

    const message = formatUncompressMessage(
        targetBlockId,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    )
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Decompress command completed", {
        targetBlockId,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    })
}
