import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { RuntimePrompts } from "../../prompts/store"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { formatMessageIdTag, type MessageIdTagMeta } from "../../message-ids"
import { compressPermission, getLastUserMessage } from "../../shared-utils"
import { saveSessionState } from "../../state/persistence"
import { countAllMessageTokens } from "../../strategies/utils"
import {
    appendIdToTool,
    createSyntheticTextPart,
    findLastToolPart,
    isIgnoredUserMessage,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimits,
    messageHasCompress,
} from "./utils"

export const injectCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    prompts: RuntimePrompts,
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    if (state.manualMode) {
        return
    }

    const lastMessage = findLastNonIgnoredMessage(messages)
    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")

    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        state.nudges.contextLimitAnchors.clear()
        state.nudges.turnNudgeAnchors.clear()
        state.nudges.iterationNudgeAnchors.clear()
        void saveSessionState(state, logger)
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    const { overMaxLimit, overMinLimit } = isContextOverLimits(
        config,
        state,
        providerId,
        modelId,
        messages,
    )

    if (!overMinLimit) {
        const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0
        const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0

        if (hadTurnAnchors || hadIterationAnchors) {
            state.nudges.turnNudgeAnchors.clear()
            state.nudges.iterationNudgeAnchors.clear()
            anchorsChanged = true
        }
    }

    if (overMaxLimit) {
        if (lastMessage) {
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.nudges.contextLimitAnchors,
                lastMessage.message.info.id,
                lastMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        }
    } else if (overMinLimit) {
        const isLastMessageUser = lastMessage?.message.info.role === "user"

        if (isLastMessageUser && lastAssistantMessage) {
            const previousSize = state.nudges.turnNudgeAnchors.size
            state.nudges.turnNudgeAnchors.add(lastMessage.message.info.id)
            state.nudges.turnNudgeAnchors.add(lastAssistantMessage.info.id)
            if (state.nudges.turnNudgeAnchors.size !== previousSize) {
                anchorsChanged = true
            }
        }

        const lastUserMessage = getLastUserMessage(messages)
        if (lastUserMessage && lastMessage) {
            const lastUserMessageIndex = messages.findIndex(
                (message) => message.info.id === lastUserMessage.info.id,
            )
            if (lastUserMessageIndex >= 0) {
                const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex)
                const iterationThreshold = getIterationNudgeThreshold(config)

                if (
                    lastMessage.index > lastUserMessageIndex &&
                    messagesSinceUser >= iterationThreshold
                ) {
                    const interval = getNudgeFrequency(config)
                    const added = addAnchor(
                        state.nudges.iterationNudgeAnchors,
                        lastMessage.message.info.id,
                        lastMessage.index,
                        messages,
                        interval,
                    )

                    if (added) {
                        anchorsChanged = true
                    }
                }
            }
        }
    }

    applyAnchoredNudges(state, config, messages, prompts)

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

export const injectMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (compressPermission(state, config) === "deny") {
        return
    }

    const tagMetaByBlockId = getBlockTagMetaMap(state, messages)

    for (const message of messages) {
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }

        const messageRef = state.messageIds.byRawId.get(message.info.id)
        if (!messageRef) {
            continue
        }

        const blockId = state.messageIds.blockByRawId.get(message.info.id)
        const tag = formatMessageIdTag(
            messageRef,
            blockId ? tagMetaByBlockId.get(blockId) : undefined,
        )

        if (message.info.role === "user") {
            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        const lastToolPart = findLastToolPart(message)
        if (lastToolPart && appendIdToTool(lastToolPart, tag)) {
            continue
        }

        const syntheticPart = createSyntheticTextPart(message, tag)
        const firstToolIndex = message.parts.findIndex((p) => p.type === "tool")
        if (firstToolIndex === -1) {
            message.parts.push(syntheticPart)
        } else {
            message.parts.splice(firstToolIndex, 0, syntheticPart)
        }
    }
}

function getBlockTagMetaMap(
    state: SessionState,
    messages: WithParts[],
): Map<number, MessageIdTagMeta> {
    const messagesByBlockId = new Map<number, WithParts[]>()

    for (const message of messages) {
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }

        const blockId = state.messageIds.blockByRawId.get(message.info.id)
        if (!blockId) {
            continue
        }

        const bucket = messagesByBlockId.get(blockId)
        if (bucket) {
            bucket.push(message)
            continue
        }

        messagesByBlockId.set(blockId, [message])
    }

    const fallbackTokensByBlockId = new Map<number, number>()
    for (const [blockId, blockMessages] of messagesByBlockId) {
        const tokens = blockMessages.reduce(
            (sum, message) => sum + countAllMessageTokens(message),
            0,
        )
        fallbackTokensByBlockId.set(blockId, tokens)
    }

    const tagMetaByBlockId = new Map<number, MessageIdTagMeta>()
    let previousRequestTokens = state.systemPromptTokens || 0

    for (const message of messages) {
        const blockId = state.messageIds.blockByRawId.get(message.info.id)
        if (!blockId || message.info.role !== "assistant") {
            continue
        }

        const requestTokens = getRequestTokens(message)
        if (requestTokens <= 0) {
            continue
        }

        const fallbackTokens = fallbackTokensByBlockId.get(blockId) || 0
        const deltaTokens = Math.max(0, requestTokens - previousRequestTokens)
        const tokens = Math.max(fallbackTokens, deltaTokens)
        tagMetaByBlockId.set(blockId, {
            tokens,
            priority: classifyPriority(tokens),
        })
        previousRequestTokens = requestTokens
    }

    for (const [blockId, fallbackTokens] of fallbackTokensByBlockId) {
        if (tagMetaByBlockId.has(blockId)) {
            continue
        }
        tagMetaByBlockId.set(blockId, {
            tokens: fallbackTokens,
            priority: classifyPriority(fallbackTokens),
        })
    }

    return tagMetaByBlockId
}

function getRequestTokens(message: WithParts): number {
    const info = message.info as AssistantMessage
    return (
        (info.tokens?.input || 0) +
        (info.tokens?.cache?.read || 0) +
        (info.tokens?.cache?.write || 0)
    )
}

function classifyPriority(tokens: number): string {
    if (tokens >= 8000) {
        return "very high"
    }
    if (tokens >= 5000) {
        return "high"
    }
    if (tokens >= 3000) {
        return "medium"
    }
    if (tokens >= 1000) {
        return "low"
    }
    return "none"
}
