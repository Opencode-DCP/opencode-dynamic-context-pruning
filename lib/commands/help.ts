/**
 * DCP Help command handler.
 * Shows available DCP commands and their descriptions.
 */

import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../strategies/utils"

export interface HelpCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

const BASE_COMMANDS: [string, string][] = [
    ["/dcp context", "Show token usage breakdown for current session"],
    ["/dcp stats", "Show DCP pruning statistics"],
    ["/dcp sweep [n]", "Prune tools since last user message, or last n tools"],
    ["/dcp manual [on|off]", "Toggle manual mode or set explicit state"],
]

const TOOL_COMMANDS: Record<string, [string, string]> = {
    compress: ["/dcp compress [focus]", "Trigger manual compress tool execution"],
}

function getVisibleCommands(config: PluginConfig): [string, string][] {
    const commands = [...BASE_COMMANDS]

    if (config.tools.compress.permission !== "deny") {
        commands.push(TOOL_COMMANDS.compress)
    }

    return commands
}

function formatHelpMessage(manualMode: boolean, config: PluginConfig): string {
    const commands = getVisibleCommands(config)
    const colWidth = Math.max(...commands.map(([cmd]) => cmd.length)) + 4
    const lines: string[] = []

    lines.push("╭─────────────────────────────────────────────────────────────────────────╮")
    lines.push("│                              DCP Commands                               │")
    lines.push("╰─────────────────────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push(`  ${"Manual mode:".padEnd(colWidth)}${manualMode ? "ON" : "OFF"}`)
    lines.push("")
    for (const [cmd, desc] of commands) {
        lines.push(`  ${cmd.padEnd(colWidth)}${desc}`)
    }
    lines.push("")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const { config } = ctx
    const message = formatHelpMessage(state.manualMode, config)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger)

    logger.info("Help command executed")
}
