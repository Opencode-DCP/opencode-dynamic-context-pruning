import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { formatMessageIdMarker } from "../../message-ids"
import { createSyntheticTextPart, createSyntheticToolPart, isIgnoredUserMessage } from "../utils"
import {
    addAnchor,
    applyAnchoredNudge,
    findLastNonIgnoredMessage,
    getNudgeGap,
    getModelInfo,
    isContextOverLimit,
    messageHasCompress,
    persistAnchors,
} from "./utils"
import { renderNudge } from "../../prompts"

const CONTEXT_LIMIT_HINT_TEXT = renderNudge("context-limit")

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
            const interval = getNudgeGap(config)
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

    applyAnchoredNudge(state.contextLimitAnchors, messages, modelId, CONTEXT_LIMIT_HINT_TEXT)

    if (anchorsChanged) {
        persistAnchors(state, logger)
    }
}

export const insertMessageIdContext = (state: SessionState, messages: WithParts[]): void => {
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

        const marker = formatMessageIdMarker(messageRef)

        if (message.info.role === "user") {
            const hasMarker = message.parts.some(
                (part) => part.type === "text" && part.text.trim() === marker,
            )
            if (!hasMarker) {
                message.parts.push(createSyntheticTextPart(message, marker))
            }
            continue
        }

        if (message.info.role !== "assistant") {
            continue
        }

        const hasMarker = message.parts.some((part) => {
            if (part.type !== "tool") {
                return false
            }
            if (part.tool !== "context_info") {
                return false
            }
            return (
                part.state?.status === "completed" &&
                typeof part.state.output === "string" &&
                part.state.output.trim() === marker
            )
        })
        if (!hasMarker) {
            message.parts.push(createSyntheticToolPart(message, marker, toolModelId))
        }
    }
}
