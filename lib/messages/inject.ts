import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { loadPrompt } from "../prompts"
import {
    extractParameterKey,
    buildToolIdList,
    createSyntheticAssistantMessage,
    createSyntheticToolPart,
    createSyntheticUserMessage,
    isIgnoredUserMessage,
    isDeepSeekOrKimi,
} from "./utils"
import { getFilePathFromParameters, isProtectedFilePath } from "../protected-file-patterns"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"

const getNudgeString = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled
    const squashEnabled = config.tools.squash.enabled

    if (discardEnabled && extractEnabled && squashEnabled) {
        return loadPrompt(`nudge/nudge-all`)
    } else if (discardEnabled && extractEnabled) {
        return loadPrompt(`nudge/nudge-discard-extract`)
    } else if (discardEnabled && squashEnabled) {
        return loadPrompt(`nudge/nudge-discard-squash`)
    } else if (extractEnabled && squashEnabled) {
        return loadPrompt(`nudge/nudge-extract-squash`)
    } else if (discardEnabled) {
        return loadPrompt(`nudge/nudge-discard`)
    } else if (extractEnabled) {
        return loadPrompt(`nudge/nudge-extract`)
    } else if (squashEnabled) {
        return loadPrompt(`nudge/nudge-squash`)
    }
    return ""
}

const wrapPrunableTools = (content: string): string => `<prunable-tools>
The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before pruning valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
${content}
</prunable-tools>`

const getCooldownMessage = (config: PluginConfig): string => {
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled
    const squashEnabled = config.tools.squash.enabled

    const enabledTools: string[] = []
    if (discardEnabled) enabledTools.push("discard")
    if (extractEnabled) enabledTools.push("extract")
    if (squashEnabled) enabledTools.push("squash")

    let toolName: string
    if (enabledTools.length === 0) {
        toolName = "pruning tools"
    } else if (enabledTools.length === 1) {
        toolName = `${enabledTools[0]} tool`
    } else {
        const last = enabledTools.pop()
        toolName = `${enabledTools.join(", ")} or ${last} tools`
    }

    return `<context-info>
Context management was just performed. Do not use the ${toolName} again. A fresh list will be available after your next tool use.
</context-info>`
}

const buildSquashContext = (state: SessionState, messages: WithParts[]): string => {
    const messageCount = messages.filter((msg) => !isMessageCompacted(state, msg)).length

    return `<squash-context>
Squash available. Conversation: ${messageCount} messages.
Squash collapses completed task sequences or exploration phases into summaries.
Uses text boundaries [startString, endString, topic, summary].
</squash-context>`
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

        const filePath = getFilePathFromParameters(toolParameterEntry.parameters)
        if (isProtectedFilePath(filePath, config.protectedFilePatterns)) {
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
    const discardEnabled = config.tools.discard.enabled
    const extractEnabled = config.tools.extract.enabled
    const squashEnabled = config.tools.squash.enabled

    if (!discardEnabled && !extractEnabled && !squashEnabled) {
        return
    }

    const discardOrExtractEnabled = discardEnabled || extractEnabled
    const contentParts: string[] = []

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        contentParts.push(getCooldownMessage(config))
    } else {
        // Inject <prunable-tools> only when discard or extract is enabled
        if (discardOrExtractEnabled) {
            const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
            if (prunableToolsList) {
                // logger.debug("prunable-tools: \n" + prunableToolsList)
                contentParts.push(prunableToolsList)
            }
        }

        // Inject <squash-context> always when squash is enabled (every turn)
        if (squashEnabled) {
            const squashContext = buildSquashContext(state, messages)
            // logger.debug("squash-context: \n" + squashContext)
            contentParts.push(squashContext)
        }

        // Add nudge if threshold reached
        if (
            config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency
        ) {
            logger.info("Inserting prune nudge message")
            contentParts.push(getNudgeString(config))
        }
    }

    if (contentParts.length === 0) {
        return
    }

    const combinedContent = contentParts.join("\n")

    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return
    }

    const userInfo = lastUserMessage.info as UserMessage
    const variant = state.variant ?? userInfo.variant

    // Find the last message that isn't an ignored user message
    const lastNonIgnoredMessage = messages.findLast(
        (msg) => !(msg.info.role === "user" && isIgnoredUserMessage(msg)),
    )

    // It's not safe to inject assistant role messages following a user message as models such
    // as Claude expect the assistant "turn" to start with reasoning parts. Reasoning parts in many
    // cases also cannot be faked as they may be encrypted by the model.
    // Gemini only accepts synth reasoning text if it is "skip_thought_signature_validator"
    if (!lastNonIgnoredMessage || lastNonIgnoredMessage.info.role === "user") {
        messages.push(createSyntheticUserMessage(lastUserMessage, combinedContent, variant))
    } else {
        // For DeepSeek and Kimi, append tool part to existing message, for some reason they don't
        // output reasoning parts following an assistant injection containing either just text part,
        // or text part with synth reasoning, and there's no docs on how their reasoning encryption
        // works as far as I can find. IDK what's going on here, seems like the only possible ways
        // to inject for them is a user role message, or a tool part apeended to last assistant message.
        const providerID = userInfo.model?.providerID || ""
        const modelID = userInfo.model?.modelID || ""
        if (isDeepSeekOrKimi(providerID, modelID)) {
            const toolPart = createSyntheticToolPart(lastNonIgnoredMessage, combinedContent)
            lastNonIgnoredMessage.parts.push(toolPart)
        } else {
            messages.push(
                createSyntheticAssistantMessage(lastUserMessage, combinedContent, variant),
            )
        }
    }
}
