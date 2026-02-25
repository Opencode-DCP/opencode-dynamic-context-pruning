import { createHash } from "node:crypto"
import { isMessageCompacted } from "../shared-utils"
import type { SessionState, WithParts } from "../state"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16
const DCP_MESSAGE_ID_TAG_REGEX = /<dcp-message-id>(?:m\d+|b\d+)<\/dcp-message-id>/g
const TURN_NUDGE_BLOCK_REGEX = /<instruction\s+name=turn_nudge\b[^>]*>[\s\S]*?<\/instruction>/g
const ITERATION_NUDGE_BLOCK_REGEX =
    /<instruction\s+name=iteration_nudge\b[^>]*>[\s\S]*?<\/instruction>/g

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
}

const isGeminiModel = (modelID: string): boolean => {
    const lowerModelID = modelID.toLowerCase()
    return lowerModelID.includes("gemini")
}

export const rejectsTextParts = (modelID: string): boolean => {
    const lowerModelID = modelID.toLowerCase()
    return lowerModelID.includes("claude") || lowerModelID.includes("deepseek")
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

    const finalContent = `<system-reminder>\nThis tool was called by the environment and is not available to the LLM.\n</system-reminder>\n${content}`

    // Gemini requires a thought signature on synthetic function calls.
    // This must live on part metadata so it maps to callProviderMetadata.
    const toolPartMetadata = isGeminiModel(modelID)
        ? {
              google: { thoughtSignature: "skip_thought_signature_validator" },
              vertex: { thoughtSignature: "skip_thought_signature_validator" },
          }
        : undefined

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "tool" as const,
        callID: callId,
        tool: "context_info",
        ...(toolPartMetadata ? { metadata: toolPartMetadata } : {}),
        state: {
            status: "completed" as const,
            input: {},
            output: finalContent,
            title: "Context Info",
            time: { start: now, end: now },
        } as any,
    }
}

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>

export const appendIdToTool = (part: ToolPart, tag: string): boolean => {
    if (part.type !== "tool") {
        return false
    }
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    if (part.state.output.includes(tag)) {
        return true
    }

    part.state.output = `${part.state.output}${tag}`
    return true
}

export const findLastToolPart = (message: WithParts): ToolPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "tool") {
            return part
        }
    }

    return null
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

export const stripHallucinations = (messages: WithParts[]): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = part.text
                    .replace(TURN_NUDGE_BLOCK_REGEX, "")
                    .replace(ITERATION_NUDGE_BLOCK_REGEX, "")
                    .replace(DCP_MESSAGE_ID_TAG_REGEX, "")
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = part.state.output
                    .replace(TURN_NUDGE_BLOCK_REGEX, "")
                    .replace(ITERATION_NUDGE_BLOCK_REGEX, "")
                    .replace(DCP_MESSAGE_ID_TAG_REGEX, "")
            }
        }
    }
}
