import { createHash } from "node:crypto"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../shared-utils"
import type { SessionState, WithParts } from "../state"
import type { UserMessage } from "@opencode-ai/sdk/v2"

const SUMMARY_ID_HASH_LENGTH = 16
const DCP_MESSAGE_ID_TAG_REGEX =
    /<dcp-message-id(?=[\s>])[^>]*>(?:m\d+|b\d+|BLOCKED)<\/dcp-message-id>/g
const DCP_BLOCK_ID_TAG_REGEX = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/dcp-message-id>)/g
const DCP_SYSTEM_REMINDER_REGEX =
    /<dcp-system-reminder(?=[\s>])[^>]*>[\s\S]*?<\/dcp-system-reminder>/g

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
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

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>
type TextPart = Extract<MessagePart, { type: "text" }>

const findLastTextPart = (message: WithParts): TextPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "text") {
            return part
        }
    }

    return null
}

export const appendToTextPart = (message: WithParts, injection: string): boolean => {
    const textPart = findLastTextPart(message)
    if (!textPart || typeof textPart.text !== "string") {
        return false
    }

    const normalizedInjection = injection.replace(/^\n+/, "")
    if (!normalizedInjection.trim()) {
        return false
    }

    const baseText = textPart.text.replace(/\n*$/, "")
    textPart.text =
        baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    return true
}

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

export function isProtectedUserMessage(config: PluginConfig, message: WithParts): boolean {
    return (
        config.compress.mode === "message" &&
        config.compress.protectUserMessages &&
        message.info.role === "user" &&
        !isIgnoredUserMessage(message)
    )
}

export const replaceBlockIdsWithBlocked = (text: string): string => {
    return text.replace(DCP_BLOCK_ID_TAG_REGEX, "$1BLOCKED$2")
}

export const stripHallucinationsFromString = (text: string): string => {
    return text.replace(DCP_SYSTEM_REMINDER_REGEX, "").replace(DCP_MESSAGE_ID_TAG_REGEX, "")
}

export const stripHallucinations = (messages: WithParts[]): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = stripHallucinationsFromString(part.text)
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = stripHallucinationsFromString(part.state.output)
            }
        }
    }
}
