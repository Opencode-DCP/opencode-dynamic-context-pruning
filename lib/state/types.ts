import { Message, Part } from "@opencode-ai/sdk/v2"
import type { SubAgentEntry } from "../config"

export interface WithParts {
    info: Message
    parts: Part[]
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolParameterEntry {
    tool: string
    parameters: any
    status?: ToolStatus
    error?: string
    turn: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface Prune {
    toolIds: string[]
}

// Sub-agent state information
export interface SubAgentState {
    // Whether DCP is enabled for this sub-agent (based on config matching)
    dcpEnabled: boolean
    // The matched sub-agent configuration (if any)
    matchedConfig: SubAgentEntry | null
    // The system prompt used for matching (cached for debugging)
    systemPrompt: string | null
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    // Sub-agent specific DCP state (experimental)
    subAgentState: SubAgentState
    prune: Prune
    stats: SessionStats
    toolParameters: Map<string, ToolParameterEntry>
    nudgeCounter: number
    lastToolPrune: boolean
    lastCompaction: number
    currentTurn: number
    variant: string | undefined
}
