import type { Logger } from "../logger"
import type { SessionState } from "../state"
import {
    countDistillationTokens,
    formatExtracted,
    formatPrunedItemsList,
    formatStatsHeader,
    formatTokenCount,
    formatProgressBar,
    truncate,
} from "./utils"
import { ToolParameterEntry } from "../state"
import { PluginConfig } from "../config"

export type PruneReason = "completion" | "noise" | "extraction"
export const PRUNE_REASON_LABELS: Record<PruneReason, string> = {
    completion: "Task Complete",
    noise: "Noise Removal",
    extraction: "Extraction",
}

const TOAST_PRUNED_ITEMS_LIMIT = 9
const TOAST_TEXT_LIMIT = 600

function buildToastBody(message: string, header: string): string {
    let toastBody = message.startsWith(header) ? message.slice(header.length).trim() : message

    const lines = toastBody.split("\n")
    const pruneIndex = lines.findIndex((line) => line.startsWith("▣ Pruning"))
    if (pruneIndex >= 0) {
        const itemStart = pruneIndex + 1
        let itemEnd = itemStart
        while (itemEnd < lines.length && lines[itemEnd].startsWith("→ ")) {
            itemEnd++
        }
        const itemLines = lines.slice(itemStart, itemEnd)
        if (itemLines.length > TOAST_PRUNED_ITEMS_LIMIT) {
            const remaining = itemLines.length - TOAST_PRUNED_ITEMS_LIMIT
            lines.splice(itemStart, itemLines.length, ...itemLines.slice(0, TOAST_PRUNED_ITEMS_LIMIT), `... and ${remaining} more`)
            toastBody = lines.join("\n")
        }
    }

    for (const marker of ["▣ Extracted", "→ Summary: "]) {
        const markerIndex = toastBody.indexOf(`\n${marker}`)
        if (markerIndex >= 0) {
            const contentStart = markerIndex + marker.length + 1
            const content = toastBody.slice(contentStart)
            const leading = content.match(/^\s*/)?.[0] || ""
            const trimmedContent = content.slice(leading.length)
            if (trimmedContent.length > TOAST_TEXT_LIMIT) {
                toastBody = toastBody.slice(0, contentStart) + leading + truncate(trimmedContent, TOAST_TEXT_LIMIT)
            }
        }
    }

    return toastBody
}

function buildPruneDetails(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory: string,
    distillation: string[] | undefined,
): string {
    if (pruneToolIds.length === 0) {
        return ""
    }

    const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
    const extractedTokens = countDistillationTokens(distillation)
    const extractedSuffix =
        extractedTokens > 0 ? `, extracted ${formatTokenCount(extractedTokens)}` : ""
    const reasonLabel = reason && extractedTokens === 0 ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""

    let message = `▣ Pruning (${pruneTokenCounterStr}${extractedSuffix})${reasonLabel}`

    const itemLines = formatPrunedItemsList(pruneToolIds, toolMetadata, workingDirectory)
    message += "\n" + itemLines.join("\n")

    return message
}

function buildMinimalMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    distillation: string[] | undefined,
    showDistillation: boolean,
): string {
    const extractedTokens = countDistillationTokens(distillation)
    const extractedSuffix =
        extractedTokens > 0 ? ` (extracted ${formatTokenCount(extractedTokens)})` : ""
    const reasonSuffix = reason && extractedTokens === 0 ? ` — ${PRUNE_REASON_LABELS[reason]}` : ""
    let message =
        formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter) +
        reasonSuffix +
        extractedSuffix

    return message + formatExtracted(showDistillation ? distillation : undefined)
}

function buildDetailedMessage(
    state: SessionState,
    reason: PruneReason | undefined,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory: string,
    distillation: string[] | undefined,
    showDistillation: boolean,
): string {
    let message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

    const details = buildPruneDetails(
        state,
        reason,
        pruneToolIds,
        toolMetadata,
        workingDirectory,
        distillation,
    )

    if (details) {
        message += "\n\n" + details
    }

    return (message + formatExtracted(showDistillation ? distillation : undefined)).trim()
}

export async function sendUnifiedNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    reason: PruneReason | undefined,
    params: any,
    workingDirectory: string,
    distillation?: string[],
): Promise<boolean> {
    const hasPruned = pruneToolIds.length > 0
    if (!hasPruned) {
        return false
    }

    if (config.pruneNotification === "off") {
        return false
    }

    const showDistillation = config.tools.extract.showDistillation

    const message =
        config.pruneNotification === "minimal"
            ? buildMinimalMessage(state, reason, distillation, showDistillation)
            : buildDetailedMessage(
                  state,
                  reason,
                  pruneToolIds,
                  toolMetadata,
                  workingDirectory,
                  distillation,
                  showDistillation,
              )

    if (config.notificationType === "toast" && client?.tui?.showToast) {
        const header = formatStatsHeader(
            state.stats.totalPruneTokens,
            state.stats.pruneTokenCounter,
        )
        const title = header.split("\n")[0]

        const toastBody = buildToastBody(message, header)

        try {
            await client.tui.showToast({
                body: {
                    title: title,
                    message: toastBody,
                    variant: "success",
                    duration: 4000,
                },
            })
            return true
        } catch (error) {
            logger.warn("Failed to show toast, falling back to message", { error })
        }
    }

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendSquashNotification(
    client: any,
    logger: Logger,
    config: PluginConfig,
    state: SessionState,
    sessionId: string,
    toolIds: string[],
    messageIds: string[],
    topic: string,
    summary: string,
    startResult: any,
    endResult: any,
    totalMessages: number,
    params: any,
): Promise<boolean> {
    if (config.pruneNotification === "off") {
        return false
    }

    let message: string

    if (config.pruneNotification === "minimal") {
        message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)
    } else {
        message = formatStatsHeader(state.stats.totalPruneTokens, state.stats.pruneTokenCounter)

        const pruneTokenCounterStr = `~${formatTokenCount(state.stats.pruneTokenCounter)}`
        const progressBar = formatProgressBar(
            totalMessages,
            startResult.messageIndex,
            endResult.messageIndex,
            25,
        )
        message += `\n\n▣ Squashing (${pruneTokenCounterStr}) ${progressBar}`
        message += `\n→ Topic: ${topic}`
        message += `\n→ Items: ${messageIds.length} messages`
        if (toolIds.length > 0) {
            message += ` and ${toolIds.length} tools condensed`
        } else {
            message += ` condensed`
        }
        if (config.tools.squash.showSummary) {
            message += `\n→ Summary: ${summary}`
        }
    }

    if (config.notificationType === "toast" && client?.tui?.showToast) {
        const header = formatStatsHeader(
            state.stats.totalPruneTokens,
            state.stats.pruneTokenCounter,
        )
        const title = header.split("\n")[0]

        const toastBody = buildToastBody(message, header)

        try {
            await client.tui.showToast({
                body: {
                    title: title,
                    message: toastBody,
                    variant: "success",
                    duration: 4000,
                },
            })
            return true
        } catch (error) {
            logger.warn("Failed to show toast, falling back to message", { error })
        }
    }

    await sendIgnoredMessage(client, sessionId, message, params, logger)
    return true
}

export async function sendIgnoredMessage(
    client: any,
    sessionID: string,
    text: string,
    params: any,
    logger: Logger,
): Promise<void> {
    const agent = params.agent || undefined
    const variant = params.variant || undefined
    const model =
        params.providerId && params.modelId
            ? {
                  providerID: params.providerId,
                  modelID: params.modelId,
              }
            : undefined

    try {
        await client.session.prompt({
            path: {
                id: sessionID,
            },
            body: {
                noReply: true,
                agent: agent,
                model: model,
                variant: variant,
                parts: [
                    {
                        type: "text",
                        text: text,
                        ignored: true,
                    },
                ],
            },
        })
    } catch (error: any) {
        logger.error("Failed to send notification", { error: error.message })
    }
}
