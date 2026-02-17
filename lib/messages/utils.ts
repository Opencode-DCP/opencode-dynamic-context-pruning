import { createHash } from "node:crypto"
import { isMessageCompacted } from "../shared-utils"
import type { SessionState, WithParts } from "../state"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
}

const isGeminiModel = (modelID: string): boolean => {
    const lowerModelID = modelID.toLowerCase()
    return lowerModelID.includes("gemini")
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    variant?: string,
    stableSeed?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const messageId = generateStableId("msg_dcp_summary", deterministicSeed)
    const partId = generateStableId("prt_dcp_summary", deterministicSeed)

    return {
        info: {
            id: messageId,
            sessionID: userInfo.sessionID,
            role: "user" as const,
            agent: userInfo.agent,
            model: userInfo.model,
            time: { created: now },
            ...(variant !== undefined && { variant }),
        },
        parts: [
            {
                id: partId,
                sessionID: userInfo.sessionID,
                messageID: messageId,
                type: "text" as const,
                text: content,
            },
        ],
    }
}

export const createSyntheticTextPart = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const partId = generateStableId("prt_dcp_text", deterministicSeed)

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text" as const,
        text: content,
    }
}

export const createSyntheticToolPart = (
    baseMessage: WithParts,
    content: string,
    modelID: string,
    stableSeed?: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()

    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const partId = generateStableId("prt_dcp_tool", deterministicSeed)
    const callId = generateStableId("call_dcp_tool", deterministicSeed)

    // Gemini requires thoughtSignature bypass to accept synthetic tool parts
    const toolPartMetadata = isGeminiModel(modelID)
        ? { google: { thoughtSignature: "skip_thought_signature_validator" } }
        : {}

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "tool" as const,
        callID: callId,
        tool: "context_info",
        state: {
            status: "completed" as const,
            input: {},
            output: content,
            title: "Context Info",
            metadata: toolPartMetadata,
            time: { start: now, end: now },
        },
    }
}

export function buildToolIdList(state: SessionState, messages: WithParts[]): string[] {
    const toolIds: string[] = []
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        if (parts.length > 0) {
            for (const part of parts) {
                if (part.type === "tool" && part.callID && part.tool) {
                    toolIds.push(part.callID)
                }
            }
        }
    }
    state.toolIdList = toolIds
    return toolIds
}

export const isIgnoredUserMessage = (message: WithParts): boolean => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) {
        return true
    }

    for (const part of parts) {
        if (!(part as any).ignored) {
            return false
        }
    }

    return true
}
