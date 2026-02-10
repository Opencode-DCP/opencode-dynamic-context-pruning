/**
 * DCP Manual mode command handler.
 * Handles toggling manual mode and triggering individual tool executions.
 *
 * Usage:
 *   /dcp manual [on|off]  - Toggle manual mode or set explicit state
 *   /dcp prune [focus]     - Trigger manual prune execution
 *   /dcp distill [focus]   - Trigger manual distill execution
 *   /dcp compress [focus]  - Trigger manual compress execution
 */

import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../strategies/utils"
import { syncToolCache } from "../state/tool-cache"
import { buildToolIdList } from "../messages/utils"
import { buildPrunableToolsList } from "../messages/inject"

// --- Messages ---

const MANUAL_MODE_ON =
    "Manual mode is now ON. Automatic context injection is disabled; use /dcp prune, /dcp distill, or /dcp compress to trigger context tools manually."

const MANUAL_MODE_OFF = "Manual mode is now OFF. Automatic context injection is enabled again."

const NO_PRUNABLE_TOOLS = "No prunable tool outputs are currently available for manual triggering."

function toolDisabledMessage(tool: string): string {
    return `The ${tool} tool is disabled by config (permission=deny).`
}

// --- Trigger prompts ---

const PRUNE_TRIGGER_PROMPT = [
    "<prune triggered manually>",
    "Manual mode trigger received. You must now use the prune tool exactly once.",
    "Find the most significant set of prunable tool outputs to remove safely.",
    "Follow prune policy and avoid pruning outputs that may be needed later.",
    "Return after prune with a brief explanation of what you pruned and why.",
].join("\n\n")

const DISTILL_TRIGGER_PROMPT = [
    "<distill triggered manually>",
    "Manual mode trigger received. You must now use the distill tool.",
    "Select the most information-dense prunable outputs and distill them into complete technical substitutes.",
    "Be exhaustive and preserve all critical technical details.",
    "Return after distill with a brief explanation of what was distilled and why.",
].join("\n\n")

const COMPRESS_TRIGGER_PROMPT = [
    "<compress triggered manually>",
    "Manual mode trigger received. You must now use the compress tool.",
    "Find the most significant completed section of the conversation that can be compressed into a high-fidelity technical summary.",
    "Choose safe boundaries and preserve all critical implementation details.",
    "Return after compress with a brief explanation of what range was compressed.",
].join("\n\n")

function getTriggerPrompt(
    tool: "prune" | "distill" | "compress",
    context?: string,
    userFocus?: string,
): string {
    const base =
        tool === "prune"
            ? PRUNE_TRIGGER_PROMPT
            : tool === "distill"
              ? DISTILL_TRIGGER_PROMPT
              : COMPRESS_TRIGGER_PROMPT

    const sections = [base]
    if (userFocus && userFocus.trim().length > 0) {
        sections.push(`Additional user focus:\n${userFocus.trim()}`)
    }
    if (context) {
        sections.push(context)
    }

    return sections.join("\n\n")
}

// --- Command context ---

export interface ManualCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

// --- Handlers ---

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

export interface ManualTriggerResult {
    prompt: string
}

export async function handleManualTriggerCommand(
    ctx: ManualCommandContext,
    tool: "prune" | "distill" | "compress",
    userFocus?: string,
): Promise<ManualTriggerResult | null> {
    const { client, state, config, logger, sessionId, messages } = ctx
    const params = getCurrentParams(state, messages, logger)

    const toolPermission = config.tools[tool].permission
    if (toolPermission === "deny") {
        await sendIgnoredMessage(client, sessionId, toolDisabledMessage(tool), params, logger)
        return null
    }

    if (tool === "prune" || tool === "distill") {
        syncToolCache(state, config, logger, messages)
        buildToolIdList(state, messages, logger)
        const prunableToolsList = buildPrunableToolsList(state, config, logger)
        if (!prunableToolsList) {
            await sendIgnoredMessage(client, sessionId, NO_PRUNABLE_TOOLS, params, logger)
            return null
        }

        return { prompt: getTriggerPrompt(tool, prunableToolsList, userFocus) }
    }

    return { prompt: getTriggerPrompt("compress", undefined, userFocus) }
}
