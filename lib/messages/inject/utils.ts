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
import { CONTEXT_LIMIT_NUDGE } from "../../prompts/nudge"
import { USER_TURN_NUDGE, ASSISTANT_TURN_NUDGE } from "../../prompts/turn-nudge"
import { ITERATION_NUDGE } from "../../prompts/iteration-nudge"

export interface LastUserModelContext {
    providerId: string | undefined
    modelId: string | undefined
}

export interface LastNonIgnoredMessage {
    message: WithParts
    index: number
}

export function getNudgeFrequency(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1))
}

export function getIterationNudgeThreshold(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1))
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

export function countMessagesAfterIndex(messages: WithParts[], index: number): number {
    let count = 0

    for (let i = index + 1; i < messages.length; i++) {
        const message = messages[i]
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }
        count++
    }

    return count
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

function resolveContextTokenLimit(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    threshold: "max" | "min",
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

    const modelLimits =
        threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits
    if (modelLimits && providerId !== undefined && modelId !== undefined) {
        const providerModelId = `${providerId}/${modelId}`
        const modelLimit = modelLimits[providerModelId]
        if (modelLimit !== undefined) {
            return parseLimitValue(modelLimit)
        }
    }

    const globalLimit =
        threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit
    return parseLimitValue(globalLimit)
}

export function isContextOverLimits(
    config: PluginConfig,
    state: SessionState,
    providerId: string | undefined,
    modelId: string | undefined,
    messages: WithParts[],
) {
    const maxContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "max")
    const minContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min")
    const currentTokens = getCurrentTokenUsage(messages)

    const overMaxLimit = maxContextLimit === undefined ? false : currentTokens > maxContextLimit
    const overMinLimit = minContextLimit === undefined ? true : currentTokens >= minContextLimit

    return {
        overMaxLimit,
        overMinLimit,
    }
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

function getActiveCompressedBlockRefs(state: SessionState): string[] {
    return Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => `b${id}`)
}

function buildCompressedBlockGuidance(refs: string[]): string {
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    return [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
        "- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using `(bN)`.",
    ].join("\n")
}

function appendGuidanceToInstructionXml(hintText: string, guidance: string): string {
    const closeTag = "</instruction>"
    const closeTagIndex = hintText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return hintText
    }

    const beforeClose = hintText.slice(0, closeTagIndex).trimEnd()
    const afterClose = hintText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}

function applyAnchoredNudge(
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

export function applyAnchoredNudges(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    modelId: string | undefined,
): void {
    const activeBlockRefs = getActiveCompressedBlockRefs(state)
    const compressedBlockGuidance = buildCompressedBlockGuidance(activeBlockRefs)

    const contextLimitNudge = appendGuidanceToInstructionXml(
        CONTEXT_LIMIT_NUDGE,
        compressedBlockGuidance,
    )

    applyAnchoredNudge(state.nudges.contextLimitAnchors, messages, modelId, contextLimitNudge)

    const turnNudgeAnchors = new Set<string>()
    const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant"
    const promptToUse =
        config.compress.nudgeForce === "strong" ? USER_TURN_NUDGE : ASSISTANT_TURN_NUDGE
    const turnNudge = appendGuidanceToInstructionXml(promptToUse, compressedBlockGuidance)

    for (const message of messages) {
        if (!state.nudges.turnNudgeAnchors.has(message.info.id)) continue

        if (message.info.role === targetRole) {
            turnNudgeAnchors.add(message.info.id)
        }
    }

    applyAnchoredNudge(turnNudgeAnchors, messages, modelId, turnNudge)

    const iterationNudge = appendGuidanceToInstructionXml(ITERATION_NUDGE, compressedBlockGuidance)
    applyAnchoredNudge(state.nudges.iterationNudgeAnchors, messages, modelId, iterationNudge)
}
