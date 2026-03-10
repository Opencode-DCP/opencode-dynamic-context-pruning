import { Logger } from "../../lib/logger"
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
import { loadAllSessionStats } from "../../lib/state/persistence"
import { analyzeTokens, emptyBreakdown } from "../../lib/analysis/tokens"
import type { DcpContextSnapshot, DcpTuiClient } from "../shared/types"

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
    messageStatuses: [],
    allTimeStats: { totalTokensSaved: 0, sessionCount: 0 },
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

const loadContextSnapshot = async (
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
    const [{ breakdown, messageStatuses }, aggregated] = await Promise.all([
        Promise.resolve(analyzeTokens(state, messages)),
        loadAllSessionStats(logger),
    ])

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
        messageStatuses,
        allTimeStats: {
            totalTokensSaved: aggregated.totalTokens,
            sessionCount: aggregated.sessionCount,
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
