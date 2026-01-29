import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted, getLastUserMessage } from "../shared-utils"
import { createSyntheticUserMessage, COMPRESS_SUMMARY_PREFIX } from "./utils"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    filterCompressedRanges(state, logger, messages)
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
    pruneToolErrors(state, logger, messages)
}

const pruneToolOutputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool === "question") {
                continue
            }

            part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
        }
    }
}

const pruneToolInputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }
            if (part.tool !== "question") {
                continue
            }

            if (part.state.input?.questions !== undefined) {
                part.state.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
            }
        }
    }
}

const pruneToolErrors = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.state.status !== "error") {
                continue
            }

            // Prune all string inputs for errored tools
            const input = part.state.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
        }
    }
}

const filterCompressedRanges = (
    state: SessionState,
    logger: Logger,
    messages: WithParts[],
): void => {
    if (!state.prune.messageIds?.length) {
        return
    }

    const result: WithParts[] = []

    for (const msg of messages) {
        const msgId = msg.info.id

        // Check if there's a summary to inject at this anchor point
        const summary = state.compressSummaries?.find((s) => s.anchorMessageId === msgId)
        if (summary) {
            // Find user message for variant and as base for synthetic message
            const msgIndex = messages.indexOf(msg)
            const userMessage = getLastUserMessage(messages, msgIndex)

            if (userMessage) {
                const userInfo = userMessage.info as UserMessage
                const summaryContent = COMPRESS_SUMMARY_PREFIX + summary.summary
                result.push(
                    createSyntheticUserMessage(userMessage, summaryContent, userInfo.variant),
                )

                logger.info("Injected compress summary", {
                    anchorMessageId: msgId,
                    summaryLength: summary.summary.length,
                })
            } else {
                logger.warn("No user message found for compress summary", {
                    anchorMessageId: msgId,
                })
            }
        }

        // Skip messages that are in the prune list
        if (state.prune.messageIds.includes(msgId)) {
            continue
        }

        // Normal message, include it
        result.push(msg)
    }

    // Replace messages array contents
    messages.length = 0
    messages.push(...result)
}
