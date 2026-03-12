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

const snapshotCache = new Map<string, DcpContextSnapshot>()
const inflightSnapshots = new Map<string, Promise<DcpContextSnapshot>>()
const CACHE_TTL_MS = 5000

export const createPlaceholderContextSnapshot = (
    sessionID?: string,
    notes: string[] = [],
): DcpContextSnapshot => ({
    sessionID,
    breakdown: emptyBreakdown(),
    persisted: {
        available: false,
        activeBlockCount: 0,
        activeBlocks: [],
        activeBlockTopicTotal: 0,
    },
    messageStatuses: [],
    allTimeStats: { totalTokensSaved: 0, sessionCount: 0 },
    notes,
    loadedAt: Date.now(),
})

function cleanBlockSummary(raw: string): string {
    return raw
        .replace(/^\s*\[Compressed conversation section\]\s*/i, "")
        .replace(/\s*<dcp-message-id>b\d+<\/dcp-message-id>\s*$/i, "")
        .trim()
}

const buildState = async (
    sessionID: string,
    messages: WithParts[],
    logger: Logger,
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
    logger: Logger,
    sessionID?: string,
): Promise<DcpContextSnapshot> => {
    if (!sessionID) {
        return createPlaceholderContextSnapshot(undefined, ["No active session."])
    }

    const messagesResult = await client.session.messages({ sessionID })
    const messages = Array.isArray(messagesResult.data)
        ? (messagesResult.data as WithParts[])
        : ([] as WithParts[])

    const { state, persisted } = await buildState(sessionID, messages, logger)
    const [{ breakdown, messageStatuses }, aggregated] = await Promise.all([
        Promise.resolve(analyzeTokens(state, messages)),
        loadAllSessionStats(logger),
    ])

    const allBlocks = Array.from(state.prune.messages.activeBlockIds)
        .map((blockID) => state.prune.messages.blocksById.get(blockID))
        .filter((block): block is NonNullable<typeof block> => !!block && !!block.topic)
        .map((block) => ({ topic: block.topic, summary: cleanBlockSummary(block.summary) }))
    const blocks = allBlocks.slice(0, 5)
    const topicTotal = allBlocks.length

    const notes: string[] = []
    if (persisted) {
        notes.push("Using live session messages plus persisted DCP state.")
    } else {
        notes.push("No saved DCP state found for this session yet.")
    }
    if (messages.length === 0) {
        notes.push("This session does not have any messages yet.")
    }

    return {
        sessionID,
        breakdown,
        persisted: {
            available: !!persisted,
            activeBlockCount: state.prune.messages.activeBlockIds.size,
            activeBlocks: blocks,
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
}

export const peekContextSnapshot = (sessionID?: string): DcpContextSnapshot | undefined => {
    if (!sessionID) return undefined
    return snapshotCache.get(sessionID)
}

export const invalidateContextSnapshot = (sessionID?: string) => {
    if (!sessionID) {
        snapshotCache.clear()
        inflightSnapshots.clear()
        return
    }
    snapshotCache.delete(sessionID)
    inflightSnapshots.delete(sessionID)
}

export const loadContextSnapshotCached = async (
    client: DcpTuiClient,
    logger: Logger,
    sessionID?: string,
): Promise<DcpContextSnapshot> => {
    if (!sessionID) {
        return createPlaceholderContextSnapshot(undefined, ["No active session."])
    }

    const cached = snapshotCache.get(sessionID)
    if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
        return cached
    }

    const inflight = inflightSnapshots.get(sessionID)
    if (inflight) {
        return inflight
    }

    const request = loadContextSnapshot(client, logger, sessionID)
        .then((snapshot) => {
            snapshotCache.set(sessionID, snapshot)
            return snapshot
        })
        .catch((error) => {
            logger.error("Failed to load TUI context snapshot", {
                sessionID,
                error: error instanceof Error ? error.message : String(error),
            })
            throw error
        })
        .finally(() => {
            inflightSnapshots.delete(sessionID)
        })

    inflightSnapshots.set(sessionID, request)
    return request
}
