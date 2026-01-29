import type { WithParts, CompressSummary } from "../state"
import type { Logger } from "../logger"

/**
 * Searches messages for a string and returns the message ID where it's found.
 * Searches in text parts, tool outputs, tool inputs, and other textual content.
 * Also searches through existing compress summaries to enable chained compression.
 * Throws an error if the string is not found or found more than once.
 */
export function findStringInMessages(
    messages: WithParts[],
    searchString: string,
    logger: Logger,
    compressSummaries: CompressSummary[] = [],
    stringType: "startString" | "endString",
): { messageId: string; messageIndex: number } {
    const matches: { messageId: string; messageIndex: number }[] = []

    // First, search through existing compress summaries
    // This allows referencing text from previous compress operations
    for (const summary of compressSummaries) {
        if (summary.summary.includes(searchString)) {
            const anchorIndex = messages.findIndex((m) => m.info.id === summary.anchorMessageId)
            if (anchorIndex !== -1) {
                matches.push({
                    messageId: summary.anchorMessageId,
                    messageIndex: anchorIndex,
                })
            }
        }
    }

    // Then search through raw messages
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []

        for (const part of parts) {
            let content = ""

            if (part.type === "text" && typeof part.text === "string") {
                content = part.text
            } else if (part.type === "tool" && part.state?.status === "completed") {
                if (typeof part.state.output === "string") {
                    content = part.state.output
                }
                if (part.state.input) {
                    const inputStr =
                        typeof part.state.input === "string"
                            ? part.state.input
                            : JSON.stringify(part.state.input)
                    content += " " + inputStr
                }
            }

            if (content.includes(searchString)) {
                matches.push({ messageId: msg.info.id, messageIndex: i })
            }
        }
    }

    if (matches.length === 0) {
        throw new Error(
            `${stringType} not found in conversation. Make sure the string exists and is spelled exactly as it appears.`,
        )
    }

    if (matches.length > 1) {
        throw new Error(
            `Found multiple matches for ${stringType}. Provide more surrounding context to uniquely identify the intended match.`,
        )
    }

    return matches[0]
}

/**
 * Collects all tool callIDs from messages between start and end indices (inclusive).
 */
export function collectToolIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const toolIds: string[] = []

    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []

        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                if (!toolIds.includes(part.callID)) {
                    toolIds.push(part.callID)
                }
            }
        }
    }

    return toolIds
}

/**
 * Collects all message IDs from messages between start and end indices (inclusive).
 */
export function collectMessageIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const messageIds: string[] = []

    for (let i = startIndex; i <= endIndex; i++) {
        const msgId = messages[i].info.id
        if (!messageIds.includes(msgId)) {
            messageIds.push(msgId)
        }
    }

    return messageIds
}

/**
 * Collects all textual content (text parts, tool inputs, and tool outputs)
 * from a range of messages. Used for token estimation.
 */
export function collectContentInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const contents: string[] = []
    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text") {
                contents.push(part.text)
            } else if (part.type === "tool") {
                const toolState = part.state as any
                if (toolState?.input) {
                    contents.push(
                        typeof toolState.input === "string"
                            ? toolState.input
                            : JSON.stringify(toolState.input),
                    )
                }
                if (toolState?.status === "completed" && toolState?.output) {
                    contents.push(
                        typeof toolState.output === "string"
                            ? toolState.output
                            : JSON.stringify(toolState.output),
                    )
                } else if (toolState?.status === "error" && toolState?.error) {
                    contents.push(
                        typeof toolState.error === "string"
                            ? toolState.error
                            : JSON.stringify(toolState.error),
                    )
                }
            }
        }
    }
    return contents
}
