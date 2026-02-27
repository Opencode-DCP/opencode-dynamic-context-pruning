import type { WithParts } from "../state"

const SUB_AGENT_RESULT_BLOCK_REGEX = /(<task_result>\s*)([\s\S]*?)(\s*<\/task_result>)/i

export function getSubAgentId(part: any): string | null {
    const sessionId = part?.state?.metadata?.sessionId
    if (typeof sessionId !== "string") {
        return null
    }

    const value = sessionId.trim()
    return value.length > 0 ? value : null
}

export function buildSubagentResultText(messages: WithParts[]): string {
    const assistantMessages = messages.filter((message) => message.info.role === "assistant")
    if (assistantMessages.length === 0) {
        return ""
    }

    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    const lastText = getLastTextPart(lastAssistant)

    if (assistantMessages.length < 2) {
        return lastText
    }

    const secondToLastAssistant = assistantMessages[assistantMessages.length - 2]
    if (!assistantMessageHasCompressTool(secondToLastAssistant)) {
        return lastText
    }

    const secondToLastText = getLastTextPart(secondToLastAssistant)
    return [secondToLastText, lastText].filter((text) => text.length > 0).join("\n\n")
}

export function mergeSubagentResult(output: string, subAgentResultText: string): string {
    if (!subAgentResultText || typeof output !== "string") {
        return output
    }

    return output.replace(
        SUB_AGENT_RESULT_BLOCK_REGEX,
        (_match, openTag: string, _body: string, closeTag: string) =>
            `${openTag}${subAgentResultText}${closeTag}`,
    )
}

function getLastTextPart(message: WithParts): string {
    const parts = Array.isArray(message.parts) ? message.parts : []
    for (let index = parts.length - 1; index >= 0; index--) {
        const part = parts[index]
        if (part.type !== "text" || typeof part.text !== "string") {
            continue
        }

        const text = part.text.trim()
        if (!text) {
            continue
        }

        return text
    }

    return ""
}

function assistantMessageHasCompressTool(message: WithParts): boolean {
    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some((part) => part.type === "tool" && part.tool === "compress")
}
