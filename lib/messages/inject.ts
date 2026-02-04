import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { renderNudge } from "../prompts"
import {
    extractParameterKey,
    buildToolIdList,
    createSyntheticTextPart,
    createSyntheticToolPart,
    isIgnoredUserMessage,
    formatContextHeader,
    type ContextInfo,
} from "./utils"
import { getFilePathsFromParameters, isProtected } from "../protected-file-patterns"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"
import { getCurrentTokenUsage } from "../strategies/utils"

export const wrapPrunableTools = (content: string, contextInfo?: ContextInfo): string => {
    const contextHeader = formatContextHeader(contextInfo)
    return `<prunable-tools>
${contextHeader}The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before pruning valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
${content}
</prunable-tools>`
}

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
    if (flags.distill) enabledTools.push("distill")
    if (flags.compress) enabledTools.push("compress")
    if (flags.prune) enabledTools.push("prune")

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

        const filePaths = getFilePathsFromParameters(
            toolParameterEntry.tool,
            toolParameterEntry.parameters,
        )
        if (isProtected(filePaths, config.protectedFilePatterns)) {
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
        const tokenSuffix =
            toolParameterEntry.tokenCount !== undefined
                ? ` (~${toolParameterEntry.tokenCount} tokens)`
                : ""
        lines.push(`${numericId}: ${description}${tokenSuffix}`)
        logger.debug(
            `Prunable tool found - ID: ${numericId}, Tool: ${toolParameterEntry.tool}, Call ID: ${toolCallId}`,
        )
    })

    if (lines.length === 0) {
        return ""
    }

    const configLimit =
        config.tools.settings.contextLimit === "model"
            ? state.modelContextLimit
            : config.tools.settings.contextLimit

    const contextInfo: ContextInfo = {
        used: getCurrentTokenUsage(messages),
        limit:
            state.modelContextLimit !== undefined && configLimit !== undefined
                ? Math.min(state.modelContextLimit, configLimit)
                : (configLimit ?? state.modelContextLimit),
    }

    return wrapPrunableTools(lines.join("\n"), contextInfo)
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

    const lastNonIgnoredMessage = messages.findLast(
        (msg) => !(msg.info.role === "user" && isIgnoredUserMessage(msg)),
    )

    if (!lastNonIgnoredMessage) {
        return
    }

    // When following a user message, append a synthetic text part since models like Claude
    // expect assistant turns to start with reasoning parts which cannot be easily faked.
    // For all other cases, append a synthetic tool part to the last message which works
    // across all models without disrupting their behavior.
    if (lastNonIgnoredMessage.info.role === "user") {
        const textPart = createSyntheticTextPart(lastNonIgnoredMessage, combinedContent)
        lastNonIgnoredMessage.parts.push(textPart)
    } else {
        const modelID = userInfo.model?.modelID || ""
        const toolPart = createSyntheticToolPart(lastNonIgnoredMessage, combinedContent, modelID)
        lastNonIgnoredMessage.parts.push(toolPart)
    }
}
