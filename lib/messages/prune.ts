import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { loadPrompt } from "../prompt"
import {
    extractParameterKey,
    buildToolIdList,
    createSyntheticUserMessage,
    createSyntheticAssistantMessage,
} from "./utils"
import { getLastAssistantMessage, getLastUserMessage, isMessageCompacted } from "../shared-utils"

const PRUNED_TOOL_INPUT_REPLACEMENT =
    "[content removed to save context, this is not what was written to the file, but a placeholder]"
const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"

const getNudgeString = (config: PluginConfig, isReasoningModel: boolean): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled
    const roleDir = isReasoningModel ? "user" : "assistant"

    if (discardEnabled && extractEnabled) {
        return loadPrompt(`${roleDir}/nudge/nudge-both`)
    } else if (discardEnabled) {
        return loadPrompt(`${roleDir}/nudge/nudge-discard`)
    } else if (extractEnabled) {
        return loadPrompt(`${roleDir}/nudge/nudge-extract`)
    }
    return ""
}

const wrapPrunableToolsUser = (content: string): string => `<prunable-tools>
The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before discarding valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
${content}
</prunable-tools>`

const wrapPrunableToolsAssistant = (content: string): string => `<prunable-tools>
I have the following tool outputs available for pruning. I should consider my current goals and the resources I need before discarding valuable inputs or outputs. I should consolidate prunes for efficiency; it is rarely worth pruning a single tiny tool output.
${content}
</prunable-tools>`

const getCooldownMessage = (config: PluginConfig, isReasoningModel: boolean): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    let toolName: string
    if (discardEnabled && extractEnabled) {
        toolName = "discard or extract tools"
    } else if (discardEnabled) {
        toolName = "discard tool"
    } else {
        toolName = "extract tool"
    }

    const message = isReasoningModel
        ? `Context management was just performed. Do not use the ${toolName} again. A fresh list will be available after your next tool use.`
        : `I just performed context management. I will not use the ${toolName} again until after my next tool use, when a fresh list will be available.`

    return `<prunable-tools>\n${message}\n</prunable-tools>`
}

const buildPrunableToolsList = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): string => {
    const lines: string[] = []
    const toolIdList: string[] = buildToolIdList(state, messages, logger)

    state.toolParameters.forEach((toolParameterEntry, toolCallId) => {
        if (state.prune.toolIds.includes(toolCallId)) {
            return
        }
        const allProtectedTools = config.tools.settings.protectedTools
        if (allProtectedTools.includes(toolParameterEntry.tool)) {
            return
        }
        const numericId = toolIdList.indexOf(toolCallId)
        if (numericId === -1) {
            logger.warn(`Tool in cache but not in toolIdList - possible stale entry`, {
                toolCallId,
                tool: toolParameterEntry.tool,
            })
            return
        }
        const paramKey = extractParameterKey(toolParameterEntry.tool, toolParameterEntry.parameters)
        const description = paramKey
            ? `${toolParameterEntry.tool}, ${paramKey}`
            : toolParameterEntry.tool
        lines.push(`${numericId}: ${description}`)
        logger.debug(
            `Prunable tool found - ID: ${numericId}, Tool: ${toolParameterEntry.tool}, Call ID: ${toolCallId}`,
        )
    })

    if (lines.length === 0) {
        return ""
    }

    const wrapFn = state.isReasoningModel ? wrapPrunableToolsUser : wrapPrunableToolsAssistant
    return wrapFn(lines.join("\n"))
}

export const insertPruneToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (!config.tools.discard.enabled && !config.tools.extract.enabled) {
        return
    }

    // For reasoning models, inject into user role; for non-reasoning, inject into assistant role
    const isReasoningModel = state.isReasoningModel

    let prunableToolsContent: string

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        prunableToolsContent = getCooldownMessage(config, isReasoningModel)
    } else {
        const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
        if (!prunableToolsList) {
            return
        }

        logger.debug("prunable-tools: \n" + prunableToolsList)

        let nudgeString = ""
        if (
            config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency
        ) {
            logger.info("Inserting prune nudge message")
            nudgeString = "\n" + getNudgeString(config, isReasoningModel)
        }

        prunableToolsContent = prunableToolsList + nudgeString
    }

    if (isReasoningModel) {
        const lastUserMessage = getLastUserMessage(messages)
        if (!lastUserMessage) {
            return
        }
        messages.push(createSyntheticUserMessage(lastUserMessage, prunableToolsContent))
    } else {
        const lastAssistantMessage = getLastAssistantMessage(messages)
        if (!lastAssistantMessage) {
            return
        }
        messages.push(createSyntheticAssistantMessage(lastAssistantMessage, prunableToolsContent))
    }
}

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
}

const pruneToolOutputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.tool === "write" || part.tool === "edit") {
                continue
            }
            if (part.state.status === "completed") {
                part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
            }
        }
    }
}

const pruneToolInputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.tool !== "write" && part.tool !== "edit") {
                continue
            }
            if (part.state.status === "pending" || part.state.status === "running") {
                continue
            }

            if (part.tool === "write" && part.state.input?.content !== undefined) {
                part.state.input.content = PRUNED_TOOL_INPUT_REPLACEMENT
            }
            if (part.tool === "edit") {
                if (part.state.input?.oldString !== undefined) {
                    part.state.input.oldString = PRUNED_TOOL_INPUT_REPLACEMENT
                }
                if (part.state.input?.newString !== undefined) {
                    part.state.input.newString = PRUNED_TOOL_INPUT_REPLACEMENT
                }
            }
        }
    }
}
