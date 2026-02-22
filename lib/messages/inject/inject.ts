import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { formatMessageIdTag } from "../../message-ids"
import { saveSessionState } from "../../state/persistence"
import {
    appendMessageIdTagToToolOutput,
    createSyntheticTextPart,
    createSyntheticToolPart,
    findLastToolPart,
    isIgnoredUserMessage,
    rejectsTextParts,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudge,
    findLastNonIgnoredMessage,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimit,
    messageHasCompress,
} from "./utils"
import { CONTEXT_LIMIT_NUDGE, TURN_NUDGE_PROMPT } from "../../prompts"

export const insertCompressToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (config.tools.compress.permission === "deny") {
        return
    }

    const lastAssistantMessage = messages.findLast((message) => message.info.role === "assistant")
    if (lastAssistantMessage && messageHasCompress(lastAssistantMessage)) {
        const hasPersistedNudgeAnchors =
            state.contextLimitAnchors.size > 0 || state.turnNudgeAnchors.size > 0
        if (hasPersistedNudgeAnchors) {
            state.contextLimitAnchors.clear()
            state.turnNudgeAnchors.clear()
            void saveSessionState(state, logger)
        }
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    const contextOverLimit = isContextOverLimit(config, state, providerId, modelId, messages)

    if (contextOverLimit) {
        const lastNonIgnoredMessage = findLastNonIgnoredMessage(messages)
        if (lastNonIgnoredMessage) {
            const interval = getNudgeFrequency(config)
            const added = addAnchor(
                state.contextLimitAnchors,
                lastNonIgnoredMessage.message.info.id,
                lastNonIgnoredMessage.index,
                messages,
                interval,
            )
            if (added) {
                anchorsChanged = true
            }
        }

        applyAnchoredNudge(state.contextLimitAnchors, messages, modelId, CONTEXT_LIMIT_NUDGE)
    } else {
        const lastMessage = messages[messages.length - 1]
        const isLastMessageNonIgnoredUser =
            lastMessage?.info.role === "user" && !isIgnoredUserMessage(lastMessage)

        if (isLastMessageNonIgnoredUser && lastAssistantMessage) {
            const previousSize = state.turnNudgeAnchors.size
            state.turnNudgeAnchors.add(lastAssistantMessage.info.id)
            if (state.turnNudgeAnchors.size !== previousSize) {
                anchorsChanged = true
            }
        }

        applyAnchoredNudge(state.turnNudgeAnchors, messages, modelId, TURN_NUDGE_PROMPT)
    }

    if (anchorsChanged) {
        void saveSessionState(state, logger)
    }
}

export const insertMessageIdContext = (
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (config.tools.compress.permission === "deny") {
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

        if (message.info.role === "user" && !isIgnoredUserMessage(message)) {
            message.parts.push(createSyntheticTextPart(message, tag))
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        const lastToolPart = findLastToolPart(message)
        if (lastToolPart && appendMessageIdTagToToolOutput(lastToolPart, tag)) {
            continue
        }

        if (rejectsTextParts(toolModelId)) {
            message.parts.push(createSyntheticToolPart(message, tag, toolModelId))
        } else {
            message.parts.push(createSyntheticTextPart(message, tag))
        }
    }
}
