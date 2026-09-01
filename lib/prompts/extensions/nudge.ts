import type { SessionState } from "../../state"
import { formatBlockRef } from "../../message-ids"

export function buildCompressedBlockGuidance(state: SessionState): string {
    const refs = Array.from(state.prune.messages.activeBlockIds)
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b)
        .map((id) => formatBlockRef(id, state.idFormat))
    const blockCount = refs.length
    const blockList = blockCount > 0 ? refs.join(", ") : "none"

    const lines: string[] = [
        "Compressed block context:",
        `- Active compressed blocks in this session: ${blockCount} (${blockList})`,
        `- If your selected compression range includes any listed block, include each required placeholder exactly once in the summary using \`${state.idFormat === "compact" ? "@b1@" : "(bN)"}\`.`,
    ]

    if (blockCount >= 2) {
        lines.push(
            "- MERGING PRIORITY: When context is still filling up, prefer consolidating multiple already-compressed blocks into ONE parent block. Set startId/endId to the outermost boundary (e.g. from b1 to b6) so DCP consumes all intermediate blocks, and write a single condensed summary. This reclaims the space taken by each child summary.",
        )
    }

    if (blockCount >= 1) {
        lines.push(
            "- KEEP SUMMARIES LEAN: A compression summary should be significantly SMALLER than the content it replaces. Do not write an exhaustive recap of what you already summarized in a child block - the child block will be removed from context once consumed.",
        )
    }

    lines.push(
        "- NO SINGLE-MESSAGE COMPRESSIONS: Compressing one fresh message into a new summary block adds context instead of saving it. If the only compressible range you can find is a single small message, do NOT compress it - merge existing blocks first, or pick a larger closed range.",
    )

    lines.push(
        "- POLL TURNS: If you are only polling a server/status and receiving NO_DONE/NOT_DONE results with no new user instruction, do not repeatedly run compress on each poll iteration. Wait for a new user message or a genuinely closed phase before compressing again.",
    )

    return lines.join("\n")
}

export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed right away if it is safe to do so.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}

export function appendGuidanceToDcpTag(nudgeText: string, guidance: string): string {
    if (!guidance.trim()) {
        return nudgeText
    }

    const closeTag = "</dcp-system-reminder>"
    const closeTagIndex = nudgeText.lastIndexOf(closeTag)

    if (closeTagIndex === -1) {
        return nudgeText
    }

    const beforeClose = nudgeText.slice(0, closeTagIndex).trimEnd()
    const afterClose = nudgeText.slice(closeTagIndex)
    return `${beforeClose}\n\n${guidance}\n${afterClose}`
}
