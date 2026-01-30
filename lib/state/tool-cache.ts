import type { SessionState, ToolStatus, WithParts } from "./index"
import type { Logger } from "../logger"
import { PluginConfig } from "../config"
import { isMessageCompacted } from "../shared-utils"

const MAX_TOOL_CACHE_SIZE = 1000
const MAX_PARAM_SIZE = 10 * 1024 // 10KB limit per parameter entry
const MAX_PATH_LENGTH = 4096

/**
 * Calculate the size of an object in bytes using JSON serialization.
 */
function calculateObjectSize(obj: any): number {
    try {
        return new Blob([JSON.stringify(obj)]).size;
    } catch {
        return 0;
    }
}

/**
 * Sync tool parameters from OpenCode's session.messages() API.
 */
export async function syncToolCache(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
): Promise<void> {
    try {
        logger.info("Syncing tool parameters from OpenCode messages")

        state.nudgeCounter = 0
        let turnCounter = 0

        for (const msg of messages) {
            if (isMessageCompacted(state, msg)) {
                continue
            }

            const parts = Array.isArray(msg.parts) ? msg.parts : []
            for (const part of parts) {
                if (part.type === "step-start") {
                    turnCounter++
                    continue
                }

                if (part.type !== "tool" || !part.callID) {
                    continue
                }

                const turnProtectionEnabled = config.turnProtection.enabled
                const turnProtectionTurns = config.turnProtection.turns
                const isProtectedByTurn =
                    turnProtectionEnabled &&
                    turnProtectionTurns > 0 &&
                    state.currentTurn - turnCounter < turnProtectionTurns

                state.lastToolPrune =
                    (part.tool === "discard" || part.tool === "extract") &&
                    part.state.status === "completed"

                const allProtectedTools = config.tools.settings.protectedTools

                if (part.tool === "discard" || part.tool === "extract") {
                    state.nudgeCounter = 0
                } else if (!allProtectedTools.includes(part.tool) && !isProtectedByTurn) {
                    state.nudgeCounter++
                }

                if (state.toolParameters.has(part.callID)) {
                    continue
                }

                if (isProtectedByTurn) {
                    continue
                }

// Calculate parameter size before caching
                const parameters = part.state?.input
                const paramSize = calculateObjectSize(parameters)
                
                if (paramSize > MAX_PARAM_SIZE) {
                    logger.warn(`Skipping tool cache entry ${part.callID}: parameters size (${paramSize} bytes) exceeds limit (${MAX_PARAM_SIZE} bytes)`)
                    continue
                }

                // Preserve null/undefined distinction explicitly
                const paramValue = parameters !== undefined ? parameters : undefined

                state.toolParameters.set(part.callID, {
                    tool: part.tool,
                    parameters: paramValue,
                    status: part.state.status as ToolStatus | undefined,
                    error: part.state.status === "error" ? part.state.error : undefined,
                    turn: turnCounter,
                    timestamp: Date.now(),
                    accessCount: 1,
                })
                logger.info(`Cached tool id: ${part.callID} (created on turn ${turnCounter})`)
            }
        }

        logger.info(
            `Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}, nudgeCounter: ${state.nudgeCounter}`,
        )
        trimToolParametersCache(state)
    } catch (error) {
        logger.warn("Failed to sync tool parameters from OpenCode", {
            error: error instanceof Error ? error.message : String(error),
        })
    }
}

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses LRU (Least Recently Used) eviction - removes least frequently used entries first.
 */
export function trimToolParametersCache(state: SessionState): void {
    if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
        return;
    }

    // Convert to array and sort by accessCount (ascending) then timestamp (ascending)
    const entries = Array.from(state.toolParameters.entries());
    entries.sort((a, b) => {
        const aEntry = a[1];
        const bEntry = b[1];
        // First sort by access count (less used = remove first)
        if (aEntry.accessCount !== bEntry.accessCount) {
            return aEntry.accessCount - bEntry.accessCount;
        }
        // Then by timestamp (older = remove first)
        return aEntry.timestamp - bEntry.timestamp;
    });

    // Remove entries until we're under limit
    const entriesToRemove = entries.slice(0, state.toolParameters.size - MAX_TOOL_CACHE_SIZE);
    for (const [key] of entriesToRemove) {
        state.toolParameters.delete(key);
    }
}
