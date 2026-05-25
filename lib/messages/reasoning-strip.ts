import type { WithParts } from "../state"
import { getLastUserMessage } from "./query"

/**
 * Mirrors opencode's differentModel handling by preserving part content while
 * dropping provider metadata on assistant parts that came from a different
 * model/provider than the current turn's user message.
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
            if (part.type !== "text" && part.type !== "tool" && part.type !== "reasoning") {
                return part
            }

            if (!("metadata" in part)) {
                return part
            }

            const { metadata: _metadata, ...rest } = part
            // Reasoning parts without metadata cannot produce valid `thinking`
            // API blocks because the required `signature` lives in metadata.
            // Downgrade to text to prevent `thinking.signature: Field required`.
            if (part.type === "reasoning") {
                return { ...rest, type: "text" }
            }
            return rest
        })
    })
}
