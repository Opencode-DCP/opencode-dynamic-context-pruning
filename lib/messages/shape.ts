import type { WithParts } from "../state"

export function isMessageWithInfo(message: unknown): message is WithParts {
    if (!message || typeof message !== "object") {
        return false
    }

    const info = (message as any).info
    const parts = (message as any).parts
    if (!info || typeof info !== "object") {
        return false
    }

    return (
        typeof info.id === "string" &&
        info.id.length > 0 &&
        (info.role === "user" ||
            info.role === "assistant" ||
            info.role === "system" ||
            info.role === "tool") &&
        Array.isArray(parts)
    )
}

export function filterMessages(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) {
        return []
    }

    return messages.filter(isMessageWithInfo)
}

export function filterMessagesInPlace(messages: unknown): WithParts[] {
    if (!Array.isArray(messages)) {
        return []
    }

    let writeIndex = 0

    for (const message of messages) {
        if (isMessageWithInfo(message)) {
            messages[writeIndex++] = message
        }
    }

    messages.length = writeIndex
    return messages as WithParts[]
}
