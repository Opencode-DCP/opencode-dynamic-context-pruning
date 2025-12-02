import { extractParameterKey } from "../../ui/display-utils"
import type { PruningStrategy, StrategyResult, ToolMetadata } from "./types"

/**
 * Deduplication strategy - prunes older tool calls that have identical
 * tool name and parameters, keeping only the most recent occurrence.
 */
export const deduplicationStrategy: PruningStrategy = {
    name: "deduplication",

    detect(
        toolMetadata: Map<string, ToolMetadata>,
        unprunedIds: string[],
        protectedTools: string[]
    ): StrategyResult {
        const signatureMap = new Map<string, string[]>()

        const deduplicatableIds = unprunedIds.filter(id => {
            const metadata = toolMetadata.get(id)
            return !metadata || !protectedTools.includes(metadata.tool)
        })

        for (const id of deduplicatableIds) {
            const metadata = toolMetadata.get(id)
            if (!metadata) continue

            const signature = createToolSignature(metadata.tool, metadata.parameters)
            if (!signatureMap.has(signature)) {
                signatureMap.set(signature, [])
            }
            signatureMap.get(signature)!.push(id)
        }

        const prunedIds: string[] = []
        const details = new Map()

        for (const [signature, ids] of signatureMap.entries()) {
            if (ids.length > 1) {
                const metadata = toolMetadata.get(ids[0])!
                const idsToRemove = ids.slice(0, -1)  // All except last
                prunedIds.push(...idsToRemove)

                details.set(signature, {
                    toolName: metadata.tool,
                    parameterKey: extractParameterKey(metadata),
                    reason: `duplicate (${ids.length} occurrences, kept most recent)`,
                    duplicateCount: ids.length,
                    prunedIds: idsToRemove,
                    keptId: ids[ids.length - 1]
                })
            }
        }

        return { prunedIds, details }
    }
}

function createToolSignature(tool: string, parameters?: any): string {
    if (!parameters) return tool

    const normalized = normalizeParameters(parameters)
    const sorted = sortObjectKeys(normalized)
    return `${tool}::${JSON.stringify(sorted)}`
}

function normalizeParameters(params: any): any {
    if (typeof params !== 'object' || params === null) return params
    if (Array.isArray(params)) return params

    const normalized: any = {}
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
            normalized[key] = value
        }
    }
    return normalized
}

function sortObjectKeys(obj: any): any {
    if (typeof obj !== 'object' || obj === null) return obj
    if (Array.isArray(obj)) return obj.map(sortObjectKeys)

    const sorted: any = {}
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
}
