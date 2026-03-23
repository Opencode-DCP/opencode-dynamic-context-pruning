import type { Logger } from "../logger"
import type { PruneMessagesState, SessionState, WithParts } from "../state"
import { syncCompressionBlocks } from "../messages"
import { parseBlockRef } from "../message-ids"
import { getCurrentParams } from "../strategies/utils"
import { saveSessionState } from "../state/persistence"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import {
    getRecompressibleCompressionTargets,
    resolveCompressionTarget,
    type CompressionTarget,
} from "./compression-targets"

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
    target: CompressionTarget,
    recompressedMessageCount: number,
    recompressedTokens: number,
    deactivatedBlockIds: number[],
): string {
    const lines: string[] = []

    lines.push(`Re-applied compression ${target.displayId}.`)
    if (target.runId !== target.displayId || target.grouped) {
        lines.push(`Tool call label: Compression #${target.runId}.`)
    }
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

function formatAvailableBlocksMessage(availableTargets: CompressionTarget[]): string {
    const lines: string[] = []

    lines.push("Usage: /dcp recompress <n>")
    lines.push("")

    if (availableTargets.length === 0) {
        lines.push("No user-decompressed blocks are available to re-compress.")
        return lines.join("\n")
    }

    lines.push("Available user-decompressed compressions:")
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
        const availableTargets = getRecompressibleCompressionTargets(
            messagesState,
            availableMessageIds,
        )
        const message = formatAvailableBlocksMessage(availableTargets)
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

    if (target.blocks.some((block) => !availableMessageIds.has(block.compressMessageId))) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Compression ${target.displayId} can no longer be re-applied because its origin message is no longer in this session.`,
            params,
            logger,
        )
        return
    }

    if (!target.blocks.some((block) => block.deactivatedByUser)) {
        const message = target.blocks.some((block) => block.active)
            ? `Compression ${target.displayId} is already active.`
            : `Compression ${target.displayId} is not user-decompressed.`
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        return
    }

    const activeMessagesBefore = snapshotActiveMessages(messagesState)
    const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

    for (const block of target.blocks) {
        block.deactivatedByUser = false
        block.deactivatedAt = undefined
        block.deactivatedByBlockId = undefined
    }

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
        target,
        recompressedMessageCount,
        recompressedTokens,
        deactivatedBlockIds,
    )
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Recompress command completed", {
        targetBlockId: target.displayId,
        targetRunId: target.runId,
        recompressedMessageCount,
        recompressedTokens,
        deactivatedBlockIds,
    })
}
