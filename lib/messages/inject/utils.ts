import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createSyntheticTextPart, createSyntheticToolPart } from "../utils"
import { getLastUserMessage } from "../../shared-utils"
import { getCurrentTokenUsage } from "../../strategies/utils"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

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

function resolveContextLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
): number | undefined {
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

export function lastMessageHasCompress(messages: WithParts[]): boolean {
    const lastAssistant = messages.findLast((message) => message.info.role === "assistant")
    if (!lastAssistant) {
        return false
    }

    const parts = Array.isArray(lastAssistant.parts) ? lastAssistant.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.state.status === "completed" && part.tool === "compress",
    )
}

export function getLastUserModelContext(messages: WithParts[]): LastUserModelContext {
    const lastUserMessage = getLastUserMessage(messages)
    if (!lastUserMessage) {
        return {
            providerId: undefined,
            modelId: undefined,
        }
    }

    const userInfo = lastUserMessage.info as UserMessage
    return {
        providerId: userInfo.model.providerID,
        modelId: userInfo.model.modelID,
    }
}

export function isContextOverLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
): boolean {
    const contextLimit = resolveContextLimit(config, state, providerId, modelId)
    if (contextLimit === undefined) {
        return false
    }

    const currentTokens = getCurrentTokenUsage(messages)
    return currentTokens > contextLimit
}

function getModelIdForMessage(
    messages: WithParts[],
    messageIndex: number,
    modelId: string | undefined,
): string {
    const userMessage = getLastUserMessage(messages, messageIndex)
    if (!userMessage) {
        return modelId || ""
    }

    const userInfo = userMessage.info as UserMessage
    return userInfo.model?.modelID || modelId || ""
}

export function injectContextLimitHint(
    messages: WithParts[],
    messageIndex: number,
    modelId: string | undefined,
    hintText: string,
): boolean {
    const message = messages[messageIndex]
    if (!message) {
        return false
    }

    if (message.info.role === "user") {
        message.parts.push(createSyntheticTextPart(message, hintText))
        return true
    }

    if (message.info.role === "assistant") {
        const toolModelId = getModelIdForMessage(messages, messageIndex, modelId)
        message.parts.push(createSyntheticToolPart(message, hintText, toolModelId))
        return true
    }

    return false
}

export function applyAnchoredHints(
    state: SessionState,
    messages: WithParts[],
    modelId: string | undefined,
    hintText: string,
): void {
    if (state.contextLimitAnchors.length === 0) {
        return
    }

    for (const anchor of state.contextLimitAnchors) {
        const messageIndex = messages.findIndex(
            (message) => message.info.id === anchor.anchorMessageId,
        )
        if (messageIndex === -1) {
            continue
        }

        injectContextLimitHint(messages, messageIndex, modelId, hintText)
    }
}
