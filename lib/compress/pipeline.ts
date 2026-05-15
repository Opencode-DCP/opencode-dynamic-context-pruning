import type { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { loadSessionState, saveSessionState } from "../state/persistence"
import { loadPruneMessagesState } from "../state/utils"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

interface PlannedCompression {
    selection: {
        requiredBlockIds: number[]
    }
}

export class RebaseConflict extends Error {
    constructor(message: string) {
        super(message)
        this.name = "RebaseConflict"
    }
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function reloadLatestState(
    state: SessionState,
    sessionId: string,
    logger: Logger,
): Promise<void> {
    if (!state.sessionId) {
        state.sessionId = sessionId
    }

    const latest = await loadSessionState(state.sessionId, logger)
    if (!latest?.prune?.messages) {
        return
    }

    const latestMessages = loadPruneMessagesState(latest.prune.messages)

    // Merge only the persisted compression block graph and its derived indexes. The
    // in-memory messageIds map was built by prepareSession for the current raw
    // message set and must not be replaced by the on-disk snapshot.
    state.prune.messages.blocksById = latestMessages.blocksById
    state.prune.messages.activeBlockIds = latestMessages.activeBlockIds
    state.prune.messages.activeByAnchorMessageId = latestMessages.activeByAnchorMessageId
    state.prune.messages.nextBlockId = latestMessages.nextBlockId
    state.prune.messages.nextRunId = latestMessages.nextRunId
}

export function rebasePlannedCompression(
    plans: PlannedCompression[],
    latestState: SessionState,
): void {
    const inactiveBlockIds = new Set<number>()
    for (const plan of plans) {
        for (const blockId of plan.selection.requiredBlockIds) {
            const block = latestState.prune.messages.blocksById.get(blockId)
            if (!block?.active) {
                inactiveBlockIds.add(blockId)
            }
        }
    }

    if (inactiveBlockIds.size > 0) {
        throw new RebaseConflict(
            `Planned compression consumed inactive block IDs: ${Array.from(inactiveBlockIds)
                .sort((left, right) => left - right)
                .map((blockId) => `b${blockId}`)
                .join(", ")}`,
        )
    }
}

export async function persistCompressionState(
    state: SessionState,
    sessionId: string,
    logger: Logger,
): Promise<void> {
    if (state.sessionId !== sessionId) {
        logger.warn("Persisting compression state for unexpected session", {
            expectedSessionId: sessionId,
            stateSessionId: state.sessionId,
        })
    }

    state.manualMode = state.manualMode ? "active" : false
    applyPendingCompressionDurations(state)
    await saveSessionState(state, logger)
}

export async function sendCompressionNotification(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}
