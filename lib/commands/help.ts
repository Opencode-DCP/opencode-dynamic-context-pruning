/**
 * DCP Help command handler.
 * Shows available DCP commands and their descriptions.
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../strategies/utils"

export interface HelpCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

function formatHelpMessage(): string {
    const lines: string[] = []

    lines.push("╭───────────────────────────────────────────────────────────╮")
    lines.push("│                      DCP Commands                         │")
    lines.push("╰───────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push("Available commands:")
    lines.push("  context  - Show token usage breakdown for current session")
    lines.push("  stats    - Show DCP pruning statistics")
    lines.push("")
    lines.push("Examples:")
    lines.push("  /dcp context")
    lines.push("  /dcp stats")
    lines.push("")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const message = formatHelpMessage()

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Help command executed")
}
