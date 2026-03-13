/**
 * DCP Context Command
 * Shows a visual breakdown of token usage in the current session.
 * Token calculation logic lives in ../analysis/tokens.ts
 *
 * TOKEN CALCULATION STRATEGY
 * ==========================
 * We minimize tokenizer estimation by leveraging API-reported values wherever possible.
 *
 * WHAT WE GET FROM THE API (exact):
 *   - tokens.input    : Input tokens for each assistant response
 *   - tokens.output   : Output tokens generated (includes text + tool calls)
 *   - tokens.reasoning: Reasoning tokens used
 *   - tokens.cache    : Cache read/write tokens
 *
 * HOW WE CALCULATE EACH CATEGORY:
 *
 *   SYSTEM = firstAssistant.input + cache.read + cache.write - tokenizer(firstUserMessage)
 *            The first response's total input (input + cache.read + cache.write)
 *            contains system + first user message. On the first request of a
 *            session, the system prompt appears in cache.write (cache creation),
 *            not cache.read.
 *
 *   TOOLS  = tokenizer(toolInputs + toolOutputs) - prunedTokens
 *            We must tokenize tools anyway for pruning decisions.
 *
 *   USER   = tokenizer(all user messages)
 *            User messages are typically small, so estimation is acceptable.
 *
 *   ASSISTANT = total - system - user - tools
 *               Calculated as residual. This absorbs:
 *               - Assistant text output tokens
 *               - Reasoning tokens (if persisted by the model)
 *               - Any estimation errors
 *
 *   TOTAL  = input + output + reasoning + cache.read + cache.write
 *            Matches opencode's UI display.
 *
 * WHY ASSISTANT IS THE RESIDUAL:
 *   If reasoning tokens persist in context (model-dependent), they semantically
 *   belong with "Assistant" since reasoning IS assistant-generated content.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { formatTokenCount } from "../ui/utils"
import { getCurrentParams } from "../strategies/utils"
import { analyzeTokens, type TokenBreakdown } from "../analysis/tokens"

export interface ContextCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

function createBar(value: number, maxValue: number, width: number, char: string = "█"): string {
    if (maxValue === 0) return ""
    const filled = Math.round((value / maxValue) * width)
    const bar = char.repeat(Math.max(0, filled))
    return bar
}

function formatContextMessage(breakdown: TokenBreakdown): string {
    const lines: string[] = []
    const barWidth = 30

    const toolsLabel = `Tools (${breakdown.toolsInContextCount})`

    const categories = [
        { label: "System", value: breakdown.system, char: "█" },
        { label: "User", value: breakdown.user, char: "▓" },
        { label: "Assistant", value: breakdown.assistant, char: "▒" },
        { label: toolsLabel, value: breakdown.tools, char: "░" },
    ] as const

    const maxLabelLen = Math.max(...categories.map((c) => c.label.length))

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                  DCP Context Analysis                     │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Session Context Breakdown:")
    lines.push("─".repeat(60))
    lines.push("")

    for (const cat of categories) {
        const bar = createBar(cat.value, breakdown.total, barWidth, cat.char)
        const percentage =
            breakdown.total > 0 ? ((cat.value / breakdown.total) * 100).toFixed(1) : "0.0"
        const labelWithPct = `${cat.label.padEnd(maxLabelLen)} ${percentage.padStart(5)}% `
        const valueStr = formatTokenCount(cat.value).padStart(13)
        lines.push(`${labelWithPct}│${bar.padEnd(barWidth)}│${valueStr}`)
    }

    lines.push("")
    lines.push("─".repeat(60))
    lines.push("")

    lines.push("Summary:")

    if (breakdown.prunedTokens > 0) {
        const withoutPruning = breakdown.total + breakdown.prunedTokens
        const pruned = []
        if (breakdown.prunedToolCount > 0) pruned.push(`${breakdown.prunedToolCount} tools`)
        if (breakdown.prunedMessageCount > 0)
            pruned.push(`${breakdown.prunedMessageCount} messages`)
        lines.push(
            `  Pruned:          ${pruned.join(", ")} (~${formatTokenCount(breakdown.prunedTokens)})`,
        )
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
        lines.push(`  Without DCP:     ~${formatTokenCount(withoutPruning)}`)
    } else {
        lines.push(`  Current context: ~${formatTokenCount(breakdown.total)}`)
    }

    lines.push("")

    return lines.join("\n")
}

export async function handleContextCommand(ctx: ContextCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const { breakdown } = analyzeTokens(state, messages)

    const message = formatContextMessage(breakdown)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
}
