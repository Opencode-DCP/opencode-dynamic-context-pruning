import { SessionState, WithParts } from "../state"
import { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Logger } from "../logger"
import { countTokens as anthropicCountTokens } from "@anthropic-ai/tokenizer"
import { getLastUserMessage } from "../shared-utils"

/**
 * Get current token usage from the last assistant message.
 * Returns total tokens (input + output + reasoning + cache).
 */
export function getCurrentTokenUsage(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant") {
            const assistantInfo = msg.info as AssistantMessage
            if (assistantInfo.tokens?.output > 0) {
                const input = assistantInfo.tokens?.input || 0
                const output = assistantInfo.tokens?.output || 0
                const reasoning = assistantInfo.tokens?.reasoning || 0
                const cacheRead = assistantInfo.tokens?.cache?.read || 0
                const cacheWrite = assistantInfo.tokens?.cache?.write || 0
                return input + output + reasoning + cacheRead + cacheWrite
            }
        }
    }
    return 0
}

export function getCurrentParams(
    state: SessionState,
    messages: WithParts[],
    logger: Logger,
): {
    providerId: string | undefined
    modelId: string | undefined
    agent: string | undefined
    variant: string | undefined
} {
    const userMsg = getLastUserMessage(messages)
    if (!userMsg) {
        logger.debug("No user message found when determining current params")
        return {
            providerId: undefined,
            modelId: undefined,
            agent: undefined,
            variant: state.variant,
        }
    }
    const userInfo = userMsg.info as UserMessage
    const agent: string = userInfo.agent
    const providerId: string | undefined = userInfo.model.providerID
    const modelId: string | undefined = userInfo.model.modelID
    const variant: string | undefined = state.variant ?? userInfo.variant

    return { providerId, modelId, agent, variant }
}

export function countTokens(text: string): number {
    if (!text) return 0
    try {
        return anthropicCountTokens(text)
    } catch {
        return Math.round(text.length / 4)
    }
}

export function estimateTokensBatch(texts: string[]): number {
    if (texts.length === 0) return 0
    return countTokens(texts.join(" "))
}

export function extractToolContent(part: any): string[] {
    const contents: string[] = []

    if (part.tool === "question") {
        const questions = part.state?.input?.questions
        if (questions !== undefined) {
            const content = typeof questions === "string" ? questions : JSON.stringify(questions)
            contents.push(content)
        }
        return contents
    }

    if (part.tool === "edit" || part.tool === "write") {
        if (part.state?.input) {
            const inputContent =
                typeof part.state.input === "string"
                    ? part.state.input
                    : JSON.stringify(part.state.input)
            contents.push(inputContent)
        }
    }

    if (part.state?.status === "completed" && part.state?.output) {
        const content =
            typeof part.state.output === "string"
                ? part.state.output
                : JSON.stringify(part.state.output)
        contents.push(content)
    } else if (part.state?.status === "error" && part.state?.error) {
        const content =
            typeof part.state.error === "string"
                ? part.state.error
                : JSON.stringify(part.state.error)
        contents.push(content)
    }

    return contents
}

export function countToolTokens(part: any): number {
    const contents = extractToolContent(part)
    return estimateTokensBatch(contents)
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
    let total = 0
    for (const id of toolIds) {
        const entry = state.toolParameters.get(id)
        total += entry?.tokenCount ?? 0
    }
    return total
}

export function countMessageTextTokens(msg: WithParts): number {
    const texts: string[] = []
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}

export function countAllMessageTokens(msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []
    for (const part of parts) {
        if (part.type === "text") {
            texts.push(part.text)
        } else {
            texts.push(...extractToolContent(part))
        }
    }
    if (texts.length === 0) return 0
    return estimateTokensBatch(texts)
}
