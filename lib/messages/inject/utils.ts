import type { SessionState, WithParts } from "../../state"
import type { PluginConfig } from "../../config"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
    createSyntheticTextPart,
    createSyntheticToolPart,
    isIgnoredUserMessage,
    rejectsTextParts,
} from "../utils"
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

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.tools.settings.nudgeFrequency || 1))
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

function resolveContextLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
): number | undefined {
    const parseLimitValue = (limit: number | `${number}%` | undefined): number | undefined => {
        if (limit === undefined) {
            return undefined
        }

        if (typeof limit === "number") {
            return limit
        }

        if (!limit.endsWith("%") || state.modelContextLimit === undefined) {
            return undefined
        }

        const parsedPercent = parseFloat(limit.slice(0, -1))
        if (isNaN(parsedPercent)) {
            return undefined
        }

        const roundedPercent = Math.round(parsedPercent)
        const clampedPercent = Math.max(0, Math.min(100, roundedPercent))
        return Math.round((clampedPercent / 100) * state.modelContextLimit)
    }

    const modelLimits = config.tools.settings.modelLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) {
            return parseLimitValue(modelLimit)
        }
    }

    return parseLimitValue(config.tools.settings.contextLimit)
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

export function addAnchor(
    anchorMessageIds: Set<string>,
    anchorMessageId: string,
    anchorMessageIndex: number,
    messages: WithParts[],
    interval: number,
): boolean {
    if (anchorMessageIndex < 0) {
        return false
    }

    let latestAnchorMessageIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (anchorMessageIds.has(messages[i].info.id)) {
            latestAnchorMessageIndex = i
            break
        }
    }

    const shouldAdd =
        latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval
    if (!shouldAdd) {
        return false
    }

    const previousSize = anchorMessageIds.size
    anchorMessageIds.add(anchorMessageId)
    return anchorMessageIds.size !== previousSize
}

export function applyAnchoredNudge(
    anchorMessageIds: Set<string>,
    messages: WithParts[],
    modelId: string | undefined,
    hintText: string,
): void {
    if (anchorMessageIds.size === 0) {
        return
    }

    for (const anchorMessageId of anchorMessageIds) {
        const messageIndex = messages.findIndex((message) => message.info.id === anchorMessageId)
        if (messageIndex === -1) {
            continue
        }

        const message = messages[messageIndex]
        if (message.info.role === "user") {
            message.parts.push(createSyntheticTextPart(message, hintText))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        const toolModelId = modelId || ""
        if (rejectsTextParts(toolModelId)) {
            message.parts.push(createSyntheticToolPart(message, hintText, toolModelId))
        } else {
            message.parts.push(createSyntheticTextPart(message, hintText))
        }
    }
}
