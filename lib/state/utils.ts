import type { SessionState, WithParts } from "./types"
import { isMessageCompacted } from "../shared-utils"
import { isIgnoredUserMessage } from "../messages/utils"

export async function isSubAgentSession(client: any, sessionID: string): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })
        return !!result.data?.parentID
    } catch (error: any) {
        return false
    }
}

export function findLastCompactionTimestamp(messages: WithParts[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role === "assistant" && msg.info.summary === true) {
            return msg.info.time.created
        }
    }
    return 0
}

export function countTurns(state: SessionState, messages: WithParts[]): number {
    let turnCount = 0
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "step-start") {
                turnCount++
            }
        }
    }
    return turnCount
}

export function loadPruneMap(
    obj?: Record<string, number>,
    legacyArr?: string[],
): Map<string, number> {
    if (obj) return new Map(Object.entries(obj))
    if (legacyArr) return new Map(legacyArr.map((id) => [id, 0]))
    return new Map()
}

function hasCompletedCompress(message: WithParts): boolean {
    if (message.info.role !== "assistant") {
        return false
    }

    const parts = Array.isArray(message.parts) ? message.parts : []
    return parts.some(
        (part) =>
            part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
    )
}

export function collectSoftNudgeAnchors(messages: WithParts[]): Set<string> {
    const anchors = new Set<string>()
    let pendingUserMessage = false

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        if (hasCompletedCompress(message)) {
            break
        }

        if (message.info.role === "user") {
            if (!isIgnoredUserMessage(message)) {
                pendingUserMessage = true
            }
            continue
        }

        if (message.info.role === "assistant" && pendingUserMessage) {
            anchors.add(message.info.id)
            pendingUserMessage = false
        }
    }

    return anchors
}

export function resetOnCompaction(state: SessionState): void {
    state.toolParameters.clear()
    state.prune.tools = new Map<string, number>()
    state.prune.messages = new Map<string, number>()
    state.compressSummaries = []
    state.contextLimitAnchors = new Set<string>()
    state.softNudgeAnchors = new Set<string>()
}
