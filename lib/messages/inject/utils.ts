import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import type { Logger } from "../../logger"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { saveSessionState } from "../../state/persistence"
import { createSyntheticTextPart, createSyntheticToolPart, isIgnoredUserMessage } from "../utils"
import { getLastUserMessage } from "../../shared-utils"
import { getCurrentTokenUsage } from "../../strategies/utils"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

export function getLimitNudgeInterval(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.tools.settings.limitNudgeInterval || 1))
}

export function persistAnchors(state: SessionState, logger: Logger): void {
    saveSessionState(state, logger).catch((error) => {
        logger.warn("Failed to persist context-limit anchors", {
            error: error instanceof Error ? error.message : String(error),
        })
    })
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

export function getModelInfo(messages: WithParts[]): LastUserModelContext {
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

export function findLastNonIgnoredMessage(messages: WithParts[]): LastNonIgnoredMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }
        return { message, index: i }
    }

    return null
}

export function messageHasCompress(message: WithParts): boolean {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.state.status === "completed" && part.tool === "compress",
    )
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

function findMessageIndexById(messages: WithParts[], messageId: string): number {
    return messages.findIndex((message) => message.info.id === messageId)
}

function getAssistantModelIdForMessageId(
    messages: WithParts[],
    messageId: string,
    fallbackModelId: string | undefined,
): string {
    const messageIndex = findMessageIndexById(messages, messageId)
    if (messageIndex === -1) {
        return fallbackModelId || ""
    }

    const userMessage = getLastUserMessage(messages, messageIndex)
    if (!userMessage) {
        return fallbackModelId || ""
    }

    const userInfo = userMessage.info as UserMessage
    return userInfo.model?.modelID || fallbackModelId || ""
}

function injectContextLimitHintAtIndex(
    messages: WithParts[],
    messageIndex: number,
    fallbackModelId: string | undefined,
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
        const toolModelId = getAssistantModelIdForMessageId(
            messages,
            message.info.id,
            fallbackModelId,
        )
        message.parts.push(createSyntheticToolPart(message, hintText, toolModelId))
        return true
    }

    return false
}

export function injectContextLimitHint(
    messages: WithParts[],
    messageId: string,
    fallbackModelId: string | undefined,
    hintText: string,
): boolean {
    const messageIndex = findMessageIndexById(messages, messageId)
    if (messageIndex === -1) {
        return false
    }

    return injectContextLimitHintAtIndex(messages, messageIndex, fallbackModelId, hintText)
}

export function findLatestAnchorMessageIndex(
    messages: WithParts[],
    anchorMessageIds: Set<string>,
): number {
    if (anchorMessageIds.size === 0) {
        return -1
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            return i
        }
    }

    return -1
}

export function shouldAddAnchor(
    lastMessageIndex: number,
    latestAnchorMessageIndex: number,
    interval: number,
): boolean {
    if (lastMessageIndex < 0) {
        return false
    }

    if (latestAnchorMessageIndex < 0) {
        return true
    }

    return lastMessageIndex - latestAnchorMessageIndex >= interval
}

export function addAnchor(anchorMessageIds: Set<string>, anchorMessageId: string): boolean {
    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

export function applyAnchoredHints(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    fallbackModelId: string | undefined,
    hintText: string,
): void {
    if (anchorMessageIds.size === 0) {
        return
    }

    for (const anchorMessageId of anchorMessageIds) {
        injectContextLimitHint(messages, anchorMessageId, fallbackModelId, hintText)
    }
}
