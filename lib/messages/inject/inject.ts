import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { formatMessageIdTag } from "../../message-ids"
import { createSyntheticTextPart, createSyntheticToolPart, isIgnoredUserMessage } from "../utils"
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

const CONTEXT_LIMIT_HINT_TEXT = renderNudge("context-limit")
type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>

const appendMessageIdTagToToolOutput = (part: ToolPart, tag: string): boolean => {
    if (part.type !== "tool") {
        return false
    }
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    if (part.state.output.includes(tag)) {
        return true
    }

    const separator = part.state.output.length > 0 && !part.state.output.endsWith("\n") ? "\n" : ""
    part.state.output = `${part.state.output}${separator}${tag}`
    return true
}

const findLastToolPart = (message: WithParts): ToolPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "tool") {
            return part
        }
    }

    return null
}

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
