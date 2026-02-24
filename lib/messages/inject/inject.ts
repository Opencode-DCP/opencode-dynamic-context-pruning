import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { formatMessageIdTag } from "../../message-ids"
import { getLastUserMessage } from "../../shared-utils"
import { saveSessionState } from "../../state/persistence"
import {
    appendIdToTool,
    createSyntheticTextPart,
    createSyntheticToolPart,
    findLastToolPart,
    isIgnoredUserMessage,
    rejectsTextParts,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudges,
    countMessagesAfterIndex,
    findLastNonIgnoredMessage,
    getIterationNudgeThreshold,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimit,
    messageHasCompress,
} from "./utils"

export const insertCompressNudges = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (config.compress.permission === "deny") {
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

    const contextOverLimit = isContextOverLimit(config, state, providerId, modelId, messages)

    if (contextOverLimit) {
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
    } else {
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

    applyAnchoredNudges(state, config, messages, modelId)

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

export const insertMessageIds = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (config.compress.permission === "deny") {
        return
    }

    const { modelId } = getModelInfo(messages)
    const toolModelId = modelId || ""

    for (const message of messages) {
        if (message.info.role === "user" && isIgnoredUserMessage(message)) {
            continue
        }

        const messageRef = state.messageIds.byRawId.get(message.info.id)
        if (!messageRef) {
            continue
        }

        const tag = formatMessageIdTag(messageRef)

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

        if (rejectsTextParts(toolModelId)) {
            message.parts.push(createSyntheticToolPart(message, tag, toolModelId))
        } else {
            message.parts.push(createSyntheticTextPart(message, tag))
        }
    }
}
