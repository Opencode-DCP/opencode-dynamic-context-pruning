/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { SessionState, SessionStats, CompressSummary } from "./types"
import type { Logger } from "../logger"

/** Prune state as stored on disk */
export interface PersistedPrune {
    // New format: tool/message IDs with token counts
    tools?: Record<string, number>
    messages?: Record<string, number>
    // Legacy format: plain ID arrays (backward compatibility)
    toolIds?: string[]
    messageIds?: string[]
}

export interface PersistedSessionState {
    sessionName?: string
    prune: PersistedPrune
    compressSummaries: CompressSummary[]
    contextLimitAnchors: string[]
    softNudgeAnchors?: string[]
    stats: SessionStats
    lastUpdated: string
}

const STORAGE_DIR = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "storage",
    "plugin",
    "dcp",
)

async function ensureStorageDir(): Promise<void> {
    if (!existsSync(STORAGE_DIR)) {
        await fs.mkdir(STORAGE_DIR, { recursive: true })
    }
}

function getSessionFilePath(sessionId: string): string {
    return join(STORAGE_DIR, `${sessionId}.json`)
}

export async function saveSessionState(
    sessionState: SessionState,
    logger: Logger,
    sessionName?: string,
): Promise<void> {
    try {
        if (!sessionState.sessionId) {
            return
        }

        await ensureStorageDir()

        const state: PersistedSessionState = {
            sessionName: sessionName,
            prune: {
                tools: Object.fromEntries(sessionState.prune.tools),
                messages: Object.fromEntries(sessionState.prune.messages),
            },
            compressSummaries: sessionState.compressSummaries,
            contextLimitAnchors: Array.from(sessionState.contextLimitAnchors),
            softNudgeAnchors: Array.from(sessionState.softNudgeAnchors),
            stats: sessionState.stats,
            lastUpdated: new Date().toISOString(),
        }

        const filePath = getSessionFilePath(sessionState.sessionId)
        const content = JSON.stringify(state, null, 2)
        await fs.writeFile(filePath, content, "utf-8")

        logger.info("Saved session state to disk", {
            sessionId: sessionState.sessionId,
            totalTokensSaved: state.stats.totalPruneTokens,
        })
    } catch (error: any) {
        logger.error("Failed to save session state", {
            sessionId: sessionState.sessionId,
            error: error?.message,
        })
    }
}

export async function loadSessionState(
    sessionId: string,
    logger: Logger,
): Promise<PersistedSessionState | null> {
    try {
        const filePath = getSessionFilePath(sessionId)

        if (!existsSync(filePath)) {
            return null
        }

        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        const hasNewFormat = state?.prune?.tools && typeof state.prune.tools === "object"
        const hasLegacyFormat = Array.isArray(state?.prune?.toolIds)
        if (!state || !state.prune || (!hasNewFormat && !hasLegacyFormat) || !state.stats) {
            logger.warn("Invalid session state file, ignoring", {
                sessionId: sessionId,
            })
            return null
        }

        if (Array.isArray(state.compressSummaries)) {
            const validSummaries = state.compressSummaries.filter(
                (s): s is CompressSummary =>
                    s !== null &&
                    typeof s === "object" &&
                    typeof s.blockId === "number" &&
                    typeof s.anchorMessageId === "string" &&
                    typeof s.summary === "string",
            )
            if (validSummaries.length !== state.compressSummaries.length) {
                logger.warn("Filtered out malformed compressSummaries entries", {
                    sessionId: sessionId,
                    original: state.compressSummaries.length,
                    valid: validSummaries.length,
                })
            }
            state.compressSummaries = validSummaries
        } else {
            state.compressSummaries = []
        }

        const rawContextLimitAnchors = Array.isArray(state.contextLimitAnchors)
            ? state.contextLimitAnchors
            : []
        const validAnchors = rawContextLimitAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedAnchors = [...new Set(validAnchors)]
        if (validAnchors.length !== rawContextLimitAnchors.length) {
            logger.warn("Filtered out malformed contextLimitAnchors entries", {
                sessionId: sessionId,
                original: rawContextLimitAnchors.length,
                valid: validAnchors.length,
            })
        }
        state.contextLimitAnchors = dedupedAnchors

        const rawSoftNudgeAnchors = Array.isArray(state.softNudgeAnchors)
            ? state.softNudgeAnchors
            : []
        const validSoftAnchors = rawSoftNudgeAnchors.filter(
            (entry): entry is string => typeof entry === "string",
        )
        const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
        if (validSoftAnchors.length !== rawSoftNudgeAnchors.length) {
            logger.warn("Filtered out malformed softNudgeAnchors entries", {
                sessionId: sessionId,
                original: rawSoftNudgeAnchors.length,
                valid: validSoftAnchors.length,
            })
        }
        state.softNudgeAnchors = dedupedSoftAnchors

        logger.info("Loaded session state from disk", {
            sessionId: sessionId,
        })

        return state
    } catch (error: any) {
        logger.warn("Failed to load session state", {
            sessionId: sessionId,
            error: error?.message,
        })
        return null
    }
}

export interface AggregatedStats {
    totalTokens: number
    totalTools: number
    totalMessages: number
    sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
    const result: AggregatedStats = {
        totalTokens: 0,
        totalTools: 0,
        totalMessages: 0,
        sessionCount: 0,
    }

    try {
        if (!existsSync(STORAGE_DIR)) {
            return result
        }

        const files = await fs.readdir(STORAGE_DIR)
        const jsonFiles = files.filter((f) => f.endsWith(".json"))

        for (const file of jsonFiles) {
            try {
                const filePath = join(STORAGE_DIR, file)
                const content = await fs.readFile(filePath, "utf-8")
                const state = JSON.parse(content) as PersistedSessionState

                if (state?.stats?.totalPruneTokens && state?.prune) {
                    result.totalTokens += state.stats.totalPruneTokens
                    result.totalTools += state.prune.tools
                        ? Object.keys(state.prune.tools).length
                        : (state.prune.toolIds?.length ?? 0)
                    result.totalMessages += state.prune.messages
                        ? Object.keys(state.prune.messages).length
                        : (state.prune.messageIds?.length ?? 0)
                    result.sessionCount++
                }
            } catch {
                // Skip invalid files
            }
        }

        logger.debug("Loaded all-time stats", result)
    } catch (error: any) {
        logger.warn("Failed to load all-time stats", { error: error?.message })
    }

    return result
}
