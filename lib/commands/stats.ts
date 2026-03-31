/**
 * DCP Stats command handler.
 * Shows pruning statistics for the current session and all-time totals.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { loadAllSessionStats, type AggregatedStats } from "../state/persistence"
import { getCurrentParams } from "../token-utils"
import { getActiveCompressionTargets } from "./compression-targets"

export interface StatsCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

function formatStatsMessage(
    sessionTokens: number,
    sessionSummaryTokens: number,
    sessionTools: number,
    sessionMessages: number,
    sessionDurationMs: number,
    allTime: AggregatedStats,
): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                    DCP Statistics                         │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Compression:")
    lines.push("─".repeat(60))
    lines.push(
        `  Tokens in|out:    ~${formatTokenCount(sessionTokens)} | ~${formatTokenCount(sessionSummaryTokens)}`,
    )
    lines.push(`  Ratio:            ${formatCompressionRatio(sessionTokens, sessionSummaryTokens)}`)
    lines.push(`  Time:             ${formatCompressionTime(sessionDurationMs)}`)
    lines.push(`  Messages:         ${sessionMessages}`)
    lines.push(`  Tools:            ${sessionTools}`)
    lines.push("")
    lines.push("All-time:")
    lines.push("─".repeat(60))
    lines.push(
        `  Tokens in|out:    ~${formatTokenCount(allTime.totalTokens)} | ~${formatTokenCount(allTime.totalSummaryTokens)}`,
    )
    lines.push(
        `  Ratio:            ${formatCompressionRatio(allTime.totalTokens, allTime.totalSummaryTokens)}`,
    )
    lines.push(`  Time:             ${formatCompressionTime(allTime.totalDurationMs)}`)
    lines.push(`  Messages:         ${allTime.totalMessages}`)
    lines.push(`  Tools:            ${allTime.totalTools}`)
    lines.push(`  Sessions:         ${allTime.sessionCount}`)

    return lines.join("\n")
}

function formatCompressionRatio(inputTokens: number, outputTokens: number): string {
    if (inputTokens <= 0) {
        return "0:1"
    }

    if (outputTokens <= 0) {
        return "∞:1"
    }

    const ratio = Math.max(1, Math.round(inputTokens / outputTokens))
    return `${ratio}:1`
}

function formatCompressionTime(ms: number): string {
    const safeMs = Math.max(0, Math.round(ms))
    if (safeMs < 1000) {
        return `${safeMs} ms`
    }

    const totalSeconds = safeMs / 1000
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)} s`
    }

    const wholeSeconds = Math.floor(totalSeconds)
    const hours = Math.floor(wholeSeconds / 3600)
    const minutes = Math.floor((wholeSeconds % 3600) / 60)
    const seconds = wholeSeconds % 60

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`
    }

    return `${minutes}m ${seconds}s`
}

export async function handleStatsCommand(ctx: StatsCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    // Session stats from in-memory state
    const sessionTokens = state.stats.totalPruneTokens
    const sessionSummaryTokens = Array.from(state.prune.messages.blocksById.values()).reduce(
        (total, block) => (block.active ? total + block.summaryTokens : total),
        0,
    )
    const sessionDurationMs = getActiveCompressionTargets(state.prune.messages).reduce(
        (total, target) => total + target.durationMs,
        0,
    )

    const prunedToolIds = new Set<string>(state.prune.tools.keys())
    for (const block of state.prune.messages.blocksById.values()) {
        if (block.active) {
            for (const toolId of block.effectiveToolIds) {
                prunedToolIds.add(toolId)
            }
        }
    }
    const sessionTools = prunedToolIds.size

    let sessionMessages = 0
    for (const entry of state.prune.messages.byMessageId.values()) {
        if (entry.activeBlockIds.length > 0) {
            sessionMessages++
        }
    }

    // All-time stats from storage files
    const allTime = await loadAllSessionStats(logger)

    const message = formatStatsMessage(
        sessionTokens,
        sessionSummaryTokens,
        sessionTools,
        sessionMessages,
        sessionDurationMs,
        allTime,
    )

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Stats command executed", {
        sessionTokens,
        sessionSummaryTokens,
        sessionTools,
        sessionMessages,
        sessionDurationMs,
        allTimeTokens: allTime.totalTokens,
        allTimeSummaryTokens: allTime.totalSummaryTokens,
        allTimeDurationMs: allTime.totalDurationMs,
        allTimeTools: allTime.totalTools,
        allTimeMessages: allTime.totalMessages,
    })
}
