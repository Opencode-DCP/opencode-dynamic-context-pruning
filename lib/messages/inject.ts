import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { renderNudge } from "../prompts"
import {
    extractParameterKey,
    buildToolIdList,
    createSyntheticUserMessage,
    createSyntheticToolPart,
    isIgnoredUserMessage,
} from "./utils"
import { getFilePathFromParameters, isProtectedFilePath } from "../protected-file-patterns"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"

export const wrapPrunableTools = (content: string): string => `<prunable-tools>
The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before pruning valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
${content}
</prunable-tools>`

export const wrapCompressContext = (messageCount: number): string => `<compress-context>
Compress available. Conversation: ${messageCount} messages.
Compress collapses completed task sequences or exploration phases into summaries.
Uses text boundaries [startString, endString, topic, summary].
</compress-context>`

export const wrapCooldownMessage = (flags: {
    prune: boolean
    distill: boolean
    compress: boolean
}): string => {
    const enabledTools: string[] = []
    if (flags.prune) enabledTools.push("prune")
    if (flags.distill) enabledTools.push("distill")
    if (flags.compress) enabledTools.push("compress")

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
Context management was just performed. Do NOT use the ${toolName} again. A fresh list will be available after your next tool use.
</context-info>`
}

const getNudgeString = (config: PluginConfig): string => {
    const flags = {
        prune: config.tools.prune.enabled,
        distill: config.tools.distill.enabled,
        compress: config.tools.compress.enabled,
    }

    if (!flags.prune && !flags.distill && !flags.compress) {
        return ""
    }

    return renderNudge(flags)
}

const getCooldownMessage = (config: PluginConfig): string => {
    return wrapCooldownMessage({
        prune: config.tools.prune.enabled,
        distill: config.tools.distill.enabled,
        compress: config.tools.compress.enabled,
    })
}

const buildCompressContext = (state: SessionState, messages: WithParts[]): string => {
    const messageCount = messages.filter((msg) => !isMessageCompacted(state, msg)).length
    return wrapCompressContext(messageCount)
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
        if (state.prune.toolIds.has(toolCallId)) {
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
    const pruneEnabled = config.tools.prune.enabled
    const distillEnabled = config.tools.distill.enabled
    const compressEnabled = config.tools.compress.enabled

    if (!pruneEnabled && !distillEnabled && !compressEnabled) {
        return
    }

    const pruneOrDistillEnabled = pruneEnabled || distillEnabled
    const contentParts: string[] = []

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        contentParts.push(getCooldownMessage(config))
    } else {
        if (pruneOrDistillEnabled) {
            const prunableToolsList = buildPrunableToolsList(state, config, logger, messages)
            if (prunableToolsList) {
                // logger.debug("prunable-tools: \n" + prunableToolsList)
                contentParts.push(prunableToolsList)
            }
        }

        if (compressEnabled) {
            const compressContext = buildCompressContext(state, messages)
            // logger.debug("compress-context: \n" + compressContext)
            contentParts.push(compressContext)
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
        // Append tool part to existing assistant message. This approach works universally across
        // models including DeepSeek and Kimi which don't output reasoning parts following an
        // assistant injection containing text parts. Tool parts appended to the last assistant
        // message are the safest way to inject context without disrupting model behavior.
        const modelID = userInfo.model?.modelID || ""
        const toolPart = createSyntheticToolPart(lastNonIgnoredMessage, combinedContent, modelID)
        lastNonIgnoredMessage.parts.push(toolPart)
    }
}
