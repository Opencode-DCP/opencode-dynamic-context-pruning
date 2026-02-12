import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import {
    addAnchor,
    applyAnchoredHints,
    findLastNonIgnoredMessage,
    getLimitNudgeInterval,
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
            const interval = getLimitNudgeInterval(config)
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

    applyAnchoredHints(state.contextLimitAnchors, messages, modelId, CONTEXT_LIMIT_HINT_TEXT)

    if (anchorsChanged) {
        persistAnchors(state, logger)
    }
}
