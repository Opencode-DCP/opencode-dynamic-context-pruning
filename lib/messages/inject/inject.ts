import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { formatMessageIdTag } from "../../message-ids"
import {
    appendMessageIdTagToToolOutput,
    createSyntheticTextPart,
    createSyntheticToolPart,
    findLastToolPart,
    isIgnoredUserMessage,
} from "../utils"
import {
    addAnchor,
    applyAnchoredNudge,
    findLastNonIgnoredMessage,
    getNudgeFrequency,
    getModelInfo,
    isContextOverLimit,
    messageHasCompress,
    persistAnchors,
} from "./utils"
import { renderNudge } from "../../prompts"

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
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    if (isContextOverLimit(config, state, providerId, modelId, messages)) {
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
    }

    applyAnchoredNudge(state.contextLimitAnchors, messages, modelId, renderNudge("context-limit"))

    if (anchorsChanged) {
        persistAnchors(state, logger)
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

        message.parts.push(createSyntheticToolPart(message, tag, toolModelId))
    }
}
