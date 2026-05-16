import type { WithParts } from "../state"
import { getLastUserMessage } from "./query"

const RELEVANT_TYPES = new Set(["text", "tool"])

/**
 * Drops stale provider metadata from assistant text/tool parts that came from a
 * different model/provider than the current turn's user message. Reasoning
 * parts pass through unchanged because opencode native handles reasoning-to-text
 * conversion for different-model requests and Anthropic requires thinking block
 * metadata to remain byte-for-byte intact.
 */
export function stripStaleMetadata(messages: WithParts[]): void {
    const lastUserMessage = getLastUserMessage(messages)
    if (lastUserMessage?.info.role !== "user") {
        return
    }

    const modelID = lastUserMessage.info.model.modelID
    const providerID = lastUserMessage.info.model.providerID

    messages.forEach((message) => {
        if (message.info.role !== "assistant") {
            return
        }

        if (message.info.modelID === modelID && message.info.providerID === providerID) {
            return
        }

        message.parts = message.parts.map((part) => {
            if (!RELEVANT_TYPES.has(part.type)) {
                return part
            }

            if (!("metadata" in part)) {
                return part
            }

            const { metadata: _metadata, ...rest } = part
            return rest
        })
    })
}
