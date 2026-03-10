import type { AssistantMessage, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Logger } from "../../lib/logger"
import { isIgnoredUserMessage } from "../../lib/messages/utils"
import { countTokens } from "../../lib/strategies/utils"
import {
    createSessionState,
    loadSessionState,
    type SessionState,
    type WithParts,
} from "../../lib/state"
import {
    findLastCompactionTimestamp,
    loadPruneMap,
    loadPruneMessagesState,
} from "../../lib/state/utils"
import { isMessageCompacted } from "../../lib/shared-utils"
import type { DcpContextBreakdown, DcpContextSnapshot, DcpTuiClient } from "../shared/types"

let logger = new Logger(false, "TUI")
const snapshotCache = new Map<string, DcpContextSnapshot>()
const inflightSnapshots = new Map<string, Promise<DcpContextSnapshot>>()
const CACHE_TTL_MS = 5000

const summarizeSnapshot = (snapshot: DcpContextSnapshot) => ({
    sessionID: snapshot.sessionID,
    totalTokens: snapshot.breakdown.total,
    messageCount: snapshot.breakdown.messageCount,
    prunedTokens: snapshot.breakdown.prunedTokens,
    activeBlockCount: snapshot.persisted.activeBlockCount,
    loadedAt: snapshot.loadedAt,
})

export const setContextLogger = (nextLogger: Logger) => {
    logger = nextLogger
}

const emptyBreakdown = (): DcpContextBreakdown => ({
    system: 0,
    user: 0,
    assistant: 0,
    tools: 0,
    toolCount: 0,
    toolsInContextCount: 0,
    prunedTokens: 0,
    prunedToolCount: 0,
    prunedMessageCount: 0,
    total: 0,
    messageCount: 0,
})

export const createPlaceholderContextSnapshot = (
    sessionID?: string,
    notes: string[] = [],
): DcpContextSnapshot => ({
    sessionID,
    breakdown: emptyBreakdown(),
    persisted: {
        available: false,
        activeBlockCount: 0,
        activeBlockTopics: [],
        activeBlockTopicTotal: 0,
    },
    notes,
    loadedAt: Date.now(),
})

const buildState = async (
    sessionID: string,
    messages: WithParts[],
): Promise<{ state: SessionState; persisted: Awaited<ReturnType<typeof loadSessionState>> }> => {
    const state = createSessionState()
    const persisted = await loadSessionState(sessionID, logger)

    state.sessionId = sessionID
    state.lastCompaction = findLastCompactionTimestamp(messages)
    state.stats.pruneTokenCounter = 0
    state.stats.totalPruneTokens = persisted?.stats?.totalPruneTokens || 0
    state.prune.tools = loadPruneMap(persisted?.prune?.tools)
    state.prune.messages = loadPruneMessagesState(persisted?.prune?.messages)

    return {
        state,
        persisted,
    }
}

const analyzeTokens = (state: SessionState, messages: WithParts[]): DcpContextBreakdown => {
    const breakdown = emptyBreakdown()
    breakdown.prunedTokens = state.stats.totalPruneTokens
    breakdown.messageCount = messages.length

    let firstAssistant: AssistantMessage | undefined
    for (const msg of messages) {
        if (msg.info.role !== "assistant") continue
        const assistantInfo = msg.info as AssistantMessage
        if (
            assistantInfo.tokens?.input > 0 ||
            assistantInfo.tokens?.cache?.read > 0 ||
            assistantInfo.tokens?.cache?.write > 0
        ) {
            firstAssistant = assistantInfo
            break
        }
    }

    let lastAssistant: AssistantMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") continue
        const assistantInfo = msg.info as AssistantMessage
        if (assistantInfo.tokens?.output > 0) {
            lastAssistant = assistantInfo
            break
        }
    }

    const apiInput = lastAssistant?.tokens?.input || 0
    const apiOutput = lastAssistant?.tokens?.output || 0
    const apiReasoning = lastAssistant?.tokens?.reasoning || 0
    const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0
    const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0
    breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite

    const userTextParts: string[] = []
    const toolInputParts: string[] = []
    const toolOutputParts: string[] = []
    const allToolIds = new Set<string>()
    const activeToolIds = new Set<string>()
    const prunedByMessageToolIds = new Set<string>()
    const allMessageIds = new Set<string>()

    let firstUserText = ""
    let foundFirstUser = false

    for (const msg of messages) {
        allMessageIds.add(msg.info.id)
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const compacted = isMessageCompacted(state, msg)
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        const messagePruned = !!pruneEntry && pruneEntry.activeBlockIds.length > 0
        const ignoredUser = msg.info.role === "user" && isIgnoredUserMessage(msg)

        for (const part of parts) {
            if (part.type === "tool") {
                const toolPart = part as ToolPart
                if (toolPart.callID) {
                    allToolIds.add(toolPart.callID)
                    if (!compacted) activeToolIds.add(toolPart.callID)
                    if (messagePruned) prunedByMessageToolIds.add(toolPart.callID)
                }

                const toolPruned = toolPart.callID && state.prune.tools.has(toolPart.callID)
                if (!compacted && !toolPruned) {
                    if (toolPart.state?.input) {
                        const inputText =
                            typeof toolPart.state.input === "string"
                                ? toolPart.state.input
                                : JSON.stringify(toolPart.state.input)
                        toolInputParts.push(inputText)
                    }
                    if (toolPart.state?.status === "completed" && toolPart.state?.output) {
                        const outputText =
                            typeof toolPart.state.output === "string"
                                ? toolPart.state.output
                                : JSON.stringify(toolPart.state.output)
                        toolOutputParts.push(outputText)
                    }
                }
                continue
            }

            if (part.type === "text" && msg.info.role === "user" && !compacted && !ignoredUser) {
                const textPart = part as TextPart
                const text = textPart.text || ""
                userTextParts.push(text)
                if (!foundFirstUser) firstUserText += text
            }
        }

        if (msg.info.role === "user" && !ignoredUser && !foundFirstUser) {
            foundFirstUser = true
        }
    }

    const prunedByToolIds = new Set<string>()
    for (const toolID of allToolIds) {
        if (state.prune.tools.has(toolID)) prunedByToolIds.add(toolID)
    }

    const prunedToolIds = new Set<string>([...prunedByToolIds, ...prunedByMessageToolIds])
    breakdown.toolCount = allToolIds.size
    breakdown.toolsInContextCount = [...activeToolIds].filter(
        (id) => !prunedByToolIds.has(id),
    ).length
    breakdown.prunedToolCount = prunedToolIds.size

    for (const [messageID, entry] of state.prune.messages.byMessageId) {
        if (allMessageIds.has(messageID) && entry.activeBlockIds.length > 0) {
            breakdown.prunedMessageCount += 1
        }
    }

    const firstUserTokens = countTokens(firstUserText)
    breakdown.user = countTokens(userTextParts.join("\n"))
    const toolInputTokens = countTokens(toolInputParts.join("\n"))
    const toolOutputTokens = countTokens(toolOutputParts.join("\n"))

    if (firstAssistant) {
        const firstInput =
            (firstAssistant.tokens?.input || 0) +
            (firstAssistant.tokens?.cache?.read || 0) +
            (firstAssistant.tokens?.cache?.write || 0)
        breakdown.system = Math.max(0, firstInput - firstUserTokens)
    }

    breakdown.tools = toolInputTokens + toolOutputTokens
    breakdown.assistant = Math.max(
        0,
        breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
    )

    return breakdown
}

export const loadContextSnapshot = async (
    client: DcpTuiClient,
    sessionID?: string,
): Promise<DcpContextSnapshot> => {
    if (!sessionID) {
        void logger.debug("Context snapshot requested without session")
        return createPlaceholderContextSnapshot(undefined, [
            "Open this panel from a session to inspect DCP context.",
        ])
    }

    void logger.debug("Loading context snapshot", { sessionID })
    const messagesResult = await client.session.messages({ sessionID })
    const messages = Array.isArray(messagesResult.data)
        ? (messagesResult.data as WithParts[])
        : ([] as WithParts[])
    void logger.debug("Fetched session messages for context snapshot", {
        sessionID,
        messageCount: messages.length,
    })

    const { state, persisted } = await buildState(sessionID, messages)
    const breakdown = analyzeTokens(state, messages)

    const allTopics = Array.from(state.prune.messages.activeBlockIds)
        .map((blockID) => state.prune.messages.blocksById.get(blockID))
        .filter((block): block is NonNullable<typeof block> => !!block)
        .map((block) => block.topic)
        .filter((topic) => !!topic)
    const topics = allTopics.slice(0, 5)
    const topicTotal = allTopics.length

    const notes: string[] = []
    if (persisted) {
        notes.push("Using live session messages plus persisted DCP state.")
    } else {
        notes.push("No saved DCP state found for this session yet.")
    }
    if (messages.length === 0) {
        notes.push("This session does not have any messages yet.")
    }

    const snapshot = {
        sessionID,
        breakdown,
        persisted: {
            available: !!persisted,
            activeBlockCount: state.prune.messages.activeBlockIds.size,
            activeBlockTopics: topics,
            activeBlockTopicTotal: topicTotal,
            lastUpdated: persisted?.lastUpdated,
        },
        notes,
        loadedAt: Date.now(),
    }

    void logger.debug("Loaded context snapshot", {
        ...summarizeSnapshot(snapshot),
        persisted: !!persisted,
    })

    return snapshot
}

export const peekContextSnapshot = (sessionID?: string): DcpContextSnapshot | undefined => {
    if (!sessionID) return undefined
    return snapshotCache.get(sessionID)
}

export const invalidateContextSnapshot = (sessionID?: string) => {
    if (!sessionID) {
        void logger.debug("Invalidating all context snapshots")
        snapshotCache.clear()
        inflightSnapshots.clear()
        return
    }

    void logger.debug("Invalidating context snapshot", { sessionID })
    snapshotCache.delete(sessionID)
    inflightSnapshots.delete(sessionID)
}

export const loadContextSnapshotCached = async (
    client: DcpTuiClient,
    sessionID?: string,
): Promise<DcpContextSnapshot> => {
    if (!sessionID) {
        void logger.debug("Cached context snapshot requested without session")
        return createPlaceholderContextSnapshot(undefined, [
            "Open this panel from a session to inspect DCP context.",
        ])
    }

    const cached = snapshotCache.get(sessionID)
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
        void logger.debug("Context snapshot cache hit", {
            sessionID,
            cacheAgeMs: Date.now() - cached.loadedAt,
        })
        return cached
    }

    if (cached) {
        void logger.debug("Context snapshot cache stale", {
            sessionID,
            cacheAgeMs: Date.now() - cached.loadedAt,
        })
    } else {
        void logger.debug("Context snapshot cache miss", { sessionID })
    }

    const inflight = inflightSnapshots.get(sessionID)
    if (inflight) {
        void logger.debug("Reusing inflight context snapshot request", { sessionID })
        return inflight
    }

    const request = loadContextSnapshot(client, sessionID)
        .then((snapshot) => {
            snapshotCache.set(sessionID, snapshot)
            void logger.debug("Stored context snapshot in cache", summarizeSnapshot(snapshot))
            return snapshot
        })
        .catch((cause) => {
            void logger.error("Context snapshot request failed", {
                sessionID,
                error: cause instanceof Error ? cause.message : String(cause),
            })
            throw cause
        })
        .finally(() => {
            inflightSnapshots.delete(sessionID)
            void logger.debug("Cleared inflight context snapshot request", { sessionID })
        })

    inflightSnapshots.set(sessionID, request)
    return request
}
