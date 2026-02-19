/**
 * DCP Manual mode command handler.
 * Handles toggling manual mode and triggering individual tool executions.
 *
 * Usage:
 *   /dcp manual [on|off]  - Toggle manual mode or set explicit state
 *   /dcp compress [focus]  - Trigger manual compress execution
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../strategies/utils"

const MANUAL_MODE_ON = "Manual mode is now ON. Use /dcp compress to trigger context tools manually."

const MANUAL_MODE_OFF = "Manual mode is now OFF."

const COMPRESS_TRIGGER_PROMPT = [
    "<compress triggered manually>",
    "Manual mode trigger received. You must now use the compress tool.",
    "Find the most significant completed section of the conversation that can be compressed into a high-fidelity technical summary.",
    "Choose safe boundaries and preserve all critical implementation details.",
    "Return after compress with a brief explanation of what range was compressed.",
].join("\n\n")

function getTriggerPrompt(tool: "compress", userFocus?: string): string {
    const base = COMPRESS_TRIGGER_PROMPT

    const sections = [base]
    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }

    return sections.join("\n\n")
}

export interface ManualCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

export async function handleManualToggleCommand(
    ctx: ManualCommandContext,
    modeArg?: string,
): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    if (modeArg === "on") {
        state.manualMode = true
    } else if (modeArg === "off") {
        state.manualMode = false
    } else {
        state.manualMode = !state.manualMode
    }

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(
        client,
        sessionId,
        state.manualMode ? MANUAL_MODE_ON : MANUAL_MODE_OFF,
        params,
        logger,
    )

    logger.info("Manual mode toggled", { manualMode: state.manualMode })
}

export async function handleManualTriggerCommand(
    ctx: ManualCommandContext,
    tool: "compress",
    userFocus?: string,
): Promise<string | null> {
    return getTriggerPrompt(tool, userFocus)
}
