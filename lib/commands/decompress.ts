import type { Logger } from "../logger"
import type { CompressionBlock, PruneMessagesState, SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../strategies/utils"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import {
    getActiveCompressionTargets,
    resolveCompressionTarget,
    type CompressionTarget,
} from "./compression-targets"

export interface DecompressCommandContext {
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

function findActiveAncestorBlockId(
    messagesState: PruneMessagesState,
    target: CompressionTarget,
): number | null {
    for (const block of target.blocks) {
        const activeAncestorBlockId = findActiveParentBlockId(messagesState, block)
        if (activeAncestorBlockId !== null) {
            return activeAncestorBlockId
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

function formatDecompressMessage(
    target: CompressionTarget,
    restoredMessageCount: number,
    restoredTokens: number,
    reactivatedBlockIds: number[],
): string {
    const lines: string[] = []

    lines.push(`Restored compression ${target.displayId}.`)
    if (target.runId !== target.displayId || target.grouped) {
        lines.push(`Tool call label: Compression #${target.runId}.`)
    }
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

function formatAvailableBlocksMessage(availableTargets: CompressionTarget[]): string {
    const lines: string[] = []

    lines.push("Usage: /dcp decompress <n>")
    lines.push("")

    if (availableTargets.length === 0) {
        lines.push("No compressions are available to restore.")
        return lines.join("\n")
    }

    lines.push("Available compressions:")
    const entries = availableTargets.map((target) => {
        const topic = target.topic.replace(/\s+/g, " ").trim() || "(no topic)"
        const label = `${target.displayId} (${formatTokenCount(target.compressedTokens)})`
        const details = target.grouped
            ? `Compression #${target.runId} - ${target.blocks.length} messages`
            : `Compression #${target.runId}`
        return { label, topic: `${details} - ${topic}` }
    })

    const labelWidth = Math.max(...entries.map((entry) => entry.label.length)) + 4
    for (const entry of entries) {
        lines.push(`  ${entry.label.padEnd(labelWidth)}${entry.topic}`)
    }

    return lines.join("\n")
}

export async function handleDecompressCommand(ctx: DecompressCommandContext): Promise<void> {
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
        const availableTargets = getActiveCompressionTargets(messagesState)
        const message = formatAvailableBlocksMessage(availableTargets)
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

    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${targetBlockId} does not exist.`,
            params,
            logger,
        )
        return
    }

    const activeBlocks = target.blocks.filter((block) => block.active)
    if (activeBlocks.length === 0) {
        const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
        if (activeAncestorBlockId !== null) {
            await sendIgnoredMessage(
                client,
                sessionId,
                `Compression ${target.displayId} is inside compression ${activeAncestorBlockId}. Restore compression ${activeAncestorBlockId} first.`,
                params,
                logger,
            )
            return
        }

        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${target.displayId} is not active.`,
            params,
            logger,
        )
        return
    }

    const activeMessagesBefore = snapshotActiveMessages(messagesState)
    const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)
    const deactivatedAt = Date.now()

    for (const block of target.blocks) {
        block.active = false
        block.deactivatedByUser = true
        block.deactivatedAt = deactivatedAt
        block.deactivatedByBlockId = undefined
    }

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

    const message = formatDecompressMessage(
        target,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    )
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Decompress command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        restoredMessageCount,
        restoredTokens,
        reactivatedBlockIds,
    })
}
