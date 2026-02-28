import type { WithParts } from "../state"
import { getLastUserMessage } from "../shared-utils"
import { isIgnoredUserMessage } from "./utils"

const isClaudeModel = (modelId: string): boolean => modelId.toLowerCase().includes("claude")

const hasReasoningPart = (msg: WithParts): boolean => {
    return msg.parts.some((part) => part.type === "reasoning")
}

const isInAgenticLoop = (messages: WithParts[]): boolean => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.info.role === "user") {
            if (isIgnoredUserMessage(message)) {
                continue
            }
            return false
        }

        if (message.info.role === "assistant") {
            return true
        }
    }

    return false
}

const findAgenticLoopStartIndex = (messages: WithParts[]): number => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.info.role !== "user") {
            continue
        }

        if (isIgnoredUserMessage(message)) {
            continue
        }

        return i + 1
    }

    return 0
}

/**
 * Necessary due to opus 4.5 and later models reusing thinking blocks from prior turns, which may
 * have invalid signatures if the user used different models in previous turns. Fixes
 * https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/issues/373
 *
 * Reference:
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking#thinking-block-preservation-in-claude-opus-4-5-and-later
 */
export function stripReasoningForClaude(messages: WithParts[]): void {
    const lastUserMessage = getLastUserMessage(messages)
    const modelId = lastUserMessage?.info.role === "user" ? lastUserMessage.info.model.modelID : ""
    if (!isClaudeModel(modelId)) {
        return
    }

    const activeLoop = isInAgenticLoop(messages)

    if (activeLoop) {
        const chainStartIdx = findAgenticLoopStartIndex(messages)
        messages.forEach((message, idx) => {
            if (message.info.role !== "assistant" || idx >= chainStartIdx) {
                return
            }

            message.parts = message.parts.filter((part) => part.type !== "reasoning")
        })
        return
    }

    let lastAssistantWithThinkingIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].info.role === "assistant" && hasReasoningPart(messages[i])) {
            lastAssistantWithThinkingIdx = i
            break
        }
    }

    messages.forEach((message, idx) => {
        if (message.info.role !== "assistant" || idx === lastAssistantWithThinkingIdx) {
            return
        }

        message.parts = message.parts.filter((part) => part.type !== "reasoning")
    })
}
