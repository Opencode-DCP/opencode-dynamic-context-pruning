import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { renderNudge } from "../prompts"
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

export const wrapContextPressureTools = (content: string): string => {
    return `<context-pressure-tools>
The following tools are currently occupying context. Use this list to decide what to compress next. Prefer high-token or clearly stale outputs first. This list guides attention; it does not force immediate compression.
${content}
</context-pressure-tools>`
}

export const wrapCompressContext = (messageCount: number): string => `<compress-context>
Compress available. Conversation: ${messageCount} messages.
Use startString/endString boundaries plus topic/summary to compress targeted ranges.
</compress-context>`

export const wrapCooldownMessage = (): string => `<context-info>
Context management was just performed. Do NOT call compress again immediately. Continue task work and reassess on the next loop.
</context-info>`

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

const shouldInjectLimitNudge = (
    config: PluginConfig,
    state: SessionState,
    messages: WithParts[],
    providerId: string | undefined,
    modelId: string | undefined,
): boolean => {
    if (config.tools.compress.permission === "deny") {
        return false
    }

    const lastAssistant = messages.findLast((msg) => msg.info.role === "assistant")
    if (lastAssistant) {
        const parts = Array.isArray(lastAssistant.parts) ? lastAssistant.parts : []
        const hasDcpTool = parts.some(
            (part) =>
                part.type === "tool" &&
                part.state.status === "completed" &&
                (part.tool === "compress" || part.tool === "prune" || part.tool === "distill"),
        )
        if (hasDcpTool) {
            return false
        }
    }

    const contextLimit = resolveContextLimit(config, state, providerId, modelId)
    if (contextLimit === undefined) {
        return false
    }

    const currentTokens = getCurrentTokenUsage(messages)
    return currentTokens > contextLimit
}

const buildCompressContext = (state: SessionState, messages: WithParts[]): string => {
    const messageCount = messages.filter((message) => !isMessageCompacted(state, message)).length
    return wrapCompressContext(messageCount)
}

const buildContextPressureTools = (state: SessionState, config: PluginConfig): string => {
    const lines: { tokens: number; text: string }[] = []
    const allProtectedTools = config.tools.settings.protectedTools

    state.toolParameters.forEach((entry, toolCallId) => {
        if (state.prune.tools.has(toolCallId)) {
            return
        }

        if (allProtectedTools.includes(entry.tool)) {
            return
        }

        const filePaths = getFilePathsFromParameters(entry.tool, entry.parameters)
        if (isProtected(filePaths, config.protectedFilePatterns)) {
            return
        }

        const paramKey = extractParameterKey(entry.tool, entry.parameters)
        const description = paramKey ? `${entry.tool}, ${paramKey}` : entry.tool
        const tokens = entry.tokenCount ?? 0
        const tokenSuffix = entry.tokenCount !== undefined ? ` (~${entry.tokenCount} tokens)` : ""
        lines.push({ tokens, text: `- ${description}${tokenSuffix}` })
    })

    if (lines.length === 0) {
        return ""
    }

    lines.sort((a, b) => b.tokens - a.tokens)
    const maxItems = 40
    const visible = lines.slice(0, maxItems)
    const hidden = lines.length - visible.length
    const content =
        visible.map((line) => line.text).join("\n") +
        (hidden > 0 ? `\n- ... ${hidden} more tool outputs not shown` : "")

    return wrapContextPressureTools(content)
}

export const insertCompressToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (state.manualMode || state.pendingManualTrigger) {
        return
    }

    if (config.tools.compress.permission === "deny") {
        return
    }

    const contentParts: string[] = []
    const lastUserMessage = getLastUserMessage(messages)
    const providerId = lastUserMessage
        ? (lastUserMessage.info as UserMessage).model.providerID
        : undefined
    const modelId = lastUserMessage
        ? (lastUserMessage.info as UserMessage).model.modelID
        : undefined

    if (state.lastToolPrune) {
        logger.debug("Last context operation was compress - injecting cooldown")
        contentParts.push(wrapCooldownMessage())
    } else {
        if (config.tools.settings.contextPressureEnabled) {
            const contextPressureTools = buildContextPressureTools(state, config)
            if (contextPressureTools) {
                contentParts.push(contextPressureTools)
            }
        }

        if (config.tools.settings.compressContextEnabled) {
            contentParts.push(buildCompressContext(state, messages))
        }

        if (shouldInjectLimitNudge(config, state, messages, providerId, modelId)) {
            logger.info("Injecting context-limit nudge")
            contentParts.push(renderNudge("context-limit"))
        } else if (
            config.tools.settings.nudgeEnabled &&
            state.nudgeCounter >= config.tools.settings.nudgeFrequency
        ) {
            logger.info("Injecting frequency nudge")
            contentParts.push(renderNudge("frequency"))
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
        (message) => !(message.info.role === "user" && isIgnoredUserMessage(message)),
    )
    if (!lastNonIgnoredMessage) {
        return
    }

    if (lastNonIgnoredMessage.info.role === "user") {
        const textPart = createSyntheticTextPart(lastNonIgnoredMessage, combinedContent)
        lastNonIgnoredMessage.parts.push(textPart)
        return
    }

    const modelID = userInfo.model?.modelID || ""
    const toolPart = createSyntheticToolPart(lastNonIgnoredMessage, combinedContent, modelID)
    lastNonIgnoredMessage.parts.push(toolPart)
}
