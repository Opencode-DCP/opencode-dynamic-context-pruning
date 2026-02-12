import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import {
    addAnchor,
    applyAnchoredHints,
    findLastNonIgnoredMessage,
    findLatestAnchorMessageIndex,
    getLimitNudgeInterval,
    getModelInfo,
    isContextOverLimit,
    messageHasCompress,
    persistAnchors,
    shouldAddAnchor,
} from "./utils"

const CONTEXT_LIMIT_HINT_TEXT = "your context exceeds the context limit, you must use compress soon"

export const insertCompressToolContext = (
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (config.tools.compress.permission === "deny") {
        return
    }

    const lastNonIgnoredMessage = findLastNonIgnoredMessage(messages)
    if (!lastNonIgnoredMessage) {
        return
    }

    if (messageHasCompress(lastNonIgnoredMessage.message)) {
        logger.debug("Skipping context-limit hint injection after compress tool output")
        return
    }

    const { providerId, modelId } = getModelInfo(messages)
    let anchorsChanged = false

    if (isContextOverLimit(config, state, providerId, modelId, messages)) {
        const interval = getLimitNudgeInterval(config)
        const latestAnchorMessageIndex = findLatestAnchorMessageIndex(
            messages,
            state.contextLimitAnchors,
        )

        if (shouldAddAnchor(lastNonIgnoredMessage.index, latestAnchorMessageIndex, interval)) {
            const anchorMessageId = lastNonIgnoredMessage.message.info.id
            const added = addAnchor(state.contextLimitAnchors, anchorMessageId)
            if (added) {
                anchorsChanged = true
                logger.info("Added context-limit anchor", {
                    anchorMessageId,
                    totalAnchors: state.contextLimitAnchors.size,
                })
            }
        }
    }

    applyAnchoredHints(state.contextLimitAnchors, messages, modelId, CONTEXT_LIMIT_HINT_TEXT)

    if (anchorsChanged) {
        persistAnchors(state, logger)
    }
}
