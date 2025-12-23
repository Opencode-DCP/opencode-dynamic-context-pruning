import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { loadPrompt } from "../prompt"
import { extractParameterKey, buildToolIdList } from "./utils"
import { getLastAssistantMessage, isMessageCompacted } from "../shared-utils"
import { AssistantMessage } from "@opencode-ai/sdk"

const PRUNED_TOOL_INPUT_REPLACEMENT = "[Input removed to save context]"
const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const getNudgeString = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled

    if (discardEnabled && extractEnabled) {
        return loadPrompt("nudge/nudge-both")
    } else if (discardEnabled) {
        return loadPrompt("nudge/nudge-discard")
    } else if (extractEnabled) {
        return loadPrompt("nudge/nudge-extract")
    }
    return ""
}

const wrapPrunableTools = (content: string): string => `<prunable-tools>
I have the following tool outputs available for pruning. I will consider my current goals and the resources I need before discarding valuable inputs or outputs. I will consolidate prunes for efficiency; it is rarely worth pruning a single tiny tool output.
${content}
</prunable-tools>`

const getCooldownMessage = (config: PluginConfig): string => {
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

    return `<prunable-tools>
I just performed context management. I should not use the ${toolName} again until after my next tool use, when a fresh list will be available.
</prunable-tools>`
}

const SYNTHETIC_MESSAGE_ID = "msg_01234567890123456789012345"
const SYNTHETIC_PART_ID = "prt_01234567890123456789012345"
const SYNTHETIC_USER_MESSAGE_ID = "msg_01234567890123456789012346"
const SYNTHETIC_USER_PART_ID = "prt_01234567890123456789012346"

// Content for the synthetic user message appended after the assistant message for reasoning models.
// This is required because reasoning models expect their reasoning parts in assistant messages,
// and we cannot generate those encrypted/proprietary parts. By closing the assistant turn with
// a user message, the model sees a complete conversation structure.
const REASONING_MODEL_USER_MESSAGE_CONTENT = "<system-context-injection/>"

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

    return wrapPrunableTools(lines.join("\n"))
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

    const lastAssistantMessage = getLastAssistantMessage(messages)
    if (!lastAssistantMessage) {
        return
    }

    let prunableToolsContent: string

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        prunableToolsContent = getCooldownMessage(config)
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
            nudgeString = "\n" + getNudgeString(config)
        }

        prunableToolsContent = prunableToolsList + nudgeString
    }

    const assistantInfo = lastAssistantMessage.info as AssistantMessage
    const assistantMessage: WithParts = {
        info: {
            id: SYNTHETIC_MESSAGE_ID,
            sessionID: assistantInfo.sessionID,
            role: "assistant",
            parentID: assistantInfo.parentID,
            modelID: assistantInfo.modelID,
            providerID: assistantInfo.providerID,
            time: { created: Date.now() },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0,
            path: assistantInfo.path,
            mode: assistantInfo.mode,
        },
        parts: [
            {
                id: SYNTHETIC_PART_ID,
                sessionID: assistantInfo.sessionID,
                messageID: SYNTHETIC_MESSAGE_ID,
                type: "text",
                text: prunableToolsContent,
            },
        ],
    }

    messages.push(assistantMessage)

    // For reasoning models, append a synthetic user message to close the assistant turn.
    // This is required because reasoning models expect their reasoning parts in the last
    // assistant message, which we cannot generate. The user message signals a complete turn.
    if (state.isReasoningModel) {
        const userMessage: WithParts = {
            info: {
                id: SYNTHETIC_USER_MESSAGE_ID,
                sessionID: assistantInfo.sessionID,
                role: "user",
                time: { created: Date.now() + 1 },
            } as any, // Using 'as any' because we're creating a minimal synthetic message
            parts: [
                {
                    id: SYNTHETIC_USER_PART_ID,
                    sessionID: assistantInfo.sessionID,
                    messageID: SYNTHETIC_USER_MESSAGE_ID,
                    type: "text",
                    text: REASONING_MODEL_USER_MESSAGE_CONTENT,
                },
            ],
        }
        messages.push(userMessage)
        logger.debug("Appended synthetic user message for reasoning model")
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
            // Skip write and edit tools - their inputs are pruned instead
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
            // Only prune inputs for write and edit tools
            if (part.tool !== "write" && part.tool !== "edit") {
                continue
            }
            // Don't prune yet if tool is still pending or running
            if (part.state.status === "pending" || part.state.status === "running") {
                continue
            }

            // Write tool has content field, edit tool has oldString/newString fields
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
