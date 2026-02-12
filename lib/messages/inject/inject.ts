import type { SessionState, WithParts } from "../../state"
import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import { saveSessionState } from "../../state/persistence"
import { isIgnoredUserMessage } from "../utils"
import {
    getLastUserModelContext,
    lastMessageHasCompress,
    injectContextLimitHint,
    isContextOverLimit,
    applyAnchoredHints,
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

    if (lastMessageHasCompress(messages)) {
        logger.debug("Skipping context-limit hint injection after compress tool output")
        return
    }

    const { providerId, modelId } = getLastUserModelContext(messages)

    applyAnchoredHints(state, messages, modelId, CONTEXT_LIMIT_HINT_TEXT)

    if (!isContextOverLimit(config, state, providerId, modelId, messages)) {
        return
    }

    if (state.limitNudgeCounter === 0) {
        const lastNonIgnoredMessageIndex = messages.findLastIndex(
            (message) => !(message.info.role === "user" && isIgnoredUserMessage(message)),
        )

        if (lastNonIgnoredMessageIndex !== -1) {
            const anchorMessageId = messages[lastNonIgnoredMessageIndex].info.id
            const injected = injectContextLimitHint(
                messages,
                lastNonIgnoredMessageIndex,
                modelId,
                CONTEXT_LIMIT_HINT_TEXT,
            )

            if (injected) {
                state.contextLimitAnchors.push({ anchorMessageId })
                logger.info("Injected context-limit hint", {
                    anchorMessageId,
                    totalAnchors: state.contextLimitAnchors.length,
                })
                saveSessionState(state, logger).catch((error) => {
                    logger.warn("Failed to persist context-limit anchors", {
                        error: error instanceof Error ? error.message : String(error),
                    })
                })
            }
        }
    }

    const interval = Math.max(1, Math.floor(config.tools.settings.limitNudgeInterval || 1))
    state.limitNudgeCounter = (state.limitNudgeCounter + 1) % interval
}
