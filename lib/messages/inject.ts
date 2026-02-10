import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { renderNudge, renderCompressNudge } from "../prompts"
import {
    extractParameterKey,
    createSyntheticTextPart,
    createSyntheticToolPart,
    isIgnoredUserMessage,
} from "./utils"
import { getFilePathsFromParameters, isProtected } from "../protected-file-patterns"
import { getLastUserMessage, isMessageCompacted } from "../shared-utils"
import { getCurrentTokenUsage } from "../strategies/utils"

function parsePercentageString(value: string, total: number): number | undefined {
    if (!value.endsWith("%")) return undefined
    const percent = parseFloat(value.slice(0, -1))

    if (isNaN(percent)) {
        return undefined
    }

    const roundedPercent = Math.round(percent)
    const clampedPercent = Math.max(0, Math.min(100, roundedPercent))

    return Math.round((clampedPercent / 100) * total)
}

// XML wrappers
export const wrapPrunableTools = (content: string): string => {
    return `<prunable-tools>
The following tools have been invoked and are available for pruning. This list does not mandate immediate action. Consider your current goals and the resources you need before pruning valuable tool inputs or outputs. Consolidate your prunes for efficiency; it is rarely worth pruning a single tiny tool output. Keep the context free of noise.
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

const resolveContextLimit = (
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
): number | undefined => {
    const modelLimits = config.tools.settings.modelLimits
    const contextLimit = config.tools.settings.contextLimit

    if (modelLimits) {
        const providerModelId =
            providerId !== undefined && modelId !== undefined
                ? `${providerId}/${modelId}`
                : undefined
        const limit = providerModelId !== undefined ? modelLimits[providerModelId] : undefined

        if (limit !== undefined) {
            if (typeof limit === "string" && limit.endsWith("%")) {
                if (state.modelContextLimit === undefined) {
                    return undefined
                }
                return parsePercentageString(limit, state.modelContextLimit)
            }
            return typeof limit === "number" ? limit : undefined
        }
    }

    if (typeof contextLimit === "string") {
        if (contextLimit.endsWith("%")) {
            if (state.modelContextLimit === undefined) {
                return undefined
            }
            return parsePercentageString(contextLimit, state.modelContextLimit)
        }
        return undefined
    }

    return contextLimit
}

const shouldInjectCompressNudge = (
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
    providerId: string | undefined,
    modelId: string | undefined,
): boolean => {
    if (config.tools.compress.permission === "deny") {
        return false
    }

    const contextLimit = resolveContextLimit(config, state, providerId, modelId)
    if (contextLimit === undefined) {
        return false
    }

    const currentTokens = getCurrentTokenUsage(messages)
    return currentTokens > contextLimit
}

const getNudgeString = (config: PluginConfig): string => {
    const flags = {
        prune: config.tools.prune.permission !== "deny",
        distill: config.tools.distill.permission !== "deny",
        compress: config.tools.compress.permission !== "deny",
        manual: false,
    }

    if (!flags.prune && !flags.distill && !flags.compress) {
        return ""
    }

    return renderNudge(flags)
}

const getCooldownMessage = (config: PluginConfig): string => {
    return wrapCooldownMessage({
        prune: config.tools.prune.permission !== "deny",
        distill: config.tools.distill.permission !== "deny",
        compress: config.tools.compress.permission !== "deny",
    })
}

const buildCompressContext = (state: SessionState, messages: WithParts[]): string => {
    const messageCount = messages.filter((msg) => !isMessageCompacted(state, msg)).length
    return wrapCompressContext(messageCount)
}

export const buildPrunableToolsList = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
): string => {
    const lines: string[] = []
    const toolIdList = state.toolIdList

    state.toolParameters.forEach((toolParameterEntry, toolCallId) => {
        if (state.prune.tools.has(toolCallId)) {
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

    return wrapPrunableTools(lines.join("\n"))
}

export const insertPruneToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (state.manualMode || state.pendingManualTrigger) {
        return
    }

    const pruneEnabled = config.tools.prune.permission !== "deny"
    const distillEnabled = config.tools.distill.permission !== "deny"
    const compressEnabled = config.tools.compress.permission !== "deny"

    if (!pruneEnabled && !distillEnabled && !compressEnabled) {
        return
    }

    const pruneOrDistillEnabled = pruneEnabled || distillEnabled
    const contentParts: string[] = []
    const lastUserMessage = getLastUserMessage(messages)
    const providerId = lastUserMessage
        ? (lastUserMessage.info as UserMessage).model.providerID
        : undefined
    const modelId = lastUserMessage
        ? (lastUserMessage.info as UserMessage).model.modelID
        : undefined

    if (state.lastToolPrune) {
        logger.debug("Last tool was prune - injecting cooldown message")
        contentParts.push(getCooldownMessage(config))
    } else {
        if (pruneOrDistillEnabled) {
            const prunableToolsList = buildPrunableToolsList(state, config, logger)
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

        if (shouldInjectCompressNudge(config, state, messages, providerId, modelId)) {
            logger.info("Inserting compress nudge - token usage exceeds contextLimit")
            contentParts.push(renderCompressNudge())
        } else if (
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
