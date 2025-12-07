import { extractParameterKey } from '../ui/display-utils'
import { getOrCreateNumericId } from '../state/id-mapping'
import type { ToolMetadata } from './types'

export interface PrunableListResult {
    list: string
    numericIds: number[]
}

export function buildPrunableToolsList(
    sessionId: string,
    unprunedToolCallIds: string[],
    toolMetadata: Map<string, ToolMetadata>,
    protectedTools: string[]
): PrunableListResult {
    const lines: string[] = []
    const numericIds: number[] = []

    for (const actualId of unprunedToolCallIds) {
        const metadata = toolMetadata.get(actualId)
        if (!metadata) continue
        if (protectedTools.includes(metadata.tool)) continue

        const numericId = getOrCreateNumericId(sessionId, actualId)
        numericIds.push(numericId)

        const paramKey = extractParameterKey(metadata)
        const description = paramKey ? `${metadata.tool}, ${paramKey}` : metadata.tool
        lines.push(`${numericId}: ${description}`)
    }

    if (lines.length === 0) {
        return { list: '', numericIds: [] }
    }

    return {
        list: `<prunable-tools>\n${lines.join('\n')}\n</prunable-tools>`,
        numericIds
    }
}

export function buildEndInjection(
    prunableList: string,
    includeNudge: boolean,
    nudgeInstruction: string,
    systemReminder: string
): string {
    if (!prunableList) {
        return ''
    }

    const parts = [systemReminder]

    if (includeNudge) {
        parts.push(nudgeInstruction)
    }

    parts.push(prunableList)

    return parts.join('\n\n')
}
