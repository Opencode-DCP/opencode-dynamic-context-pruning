import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { saveSessionState } from "../../state/persistence"
import {
    addAnchor,
    applyAnchoredHints,
    findLastNonIgnoredMessage,
    findLatestAnchorMessageIndex,
    getLastUserModelContext,
    isContextOverLimit,
    messageHasCompress,
    shouldAddAnchor,
} from "./utils"

const CONTEXT_LIMIT_HINT_TEXT = "your context exceeds the context limit, you must use compress soon"

function getLimitNudgeInterval(config: PluginConfig): number {
    return Math.max(1, Math.floor(config.tools.settings.limitNudgeInterval || 1))
}

function persistAnchors(state: SessionState, logger: Logger): void {
    saveSessionState(state, logger).catch((error) => {
        logger.warn("Failed to persist context-limit anchors", {
            error: error instanceof Error ? error.message : String(error),
        })
    })
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

    const lastNonIgnoredMessage = findLastNonIgnoredMessage(messages)
    if (!lastNonIgnoredMessage) {
        return
    }

    if (messageHasCompress(lastNonIgnoredMessage.message)) {
        logger.debug("Skipping context-limit hint injection after compress tool output")
        return
    }

    const { providerId, modelId } = getLastUserModelContext(messages)
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
