import { SessionState, WithParts } from "./state"
import { isIgnoredUserMessage } from "./messages/utils"

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
    return msg.info.time.created < state.lastCompaction
}

export const getLastUserMessage = (
    messages: WithParts[],
    startIndex?: number,
): WithParts | null => {
    const start = startIndex ?? messages.length - 1
    for (let i = start; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
            return msg
        }
    }
    return null
}
