import { Message, Part } from "@opencode-ai/sdk/v2"

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
    tokenCount?: number
}

export interface SessionStats {
    pruneTokenCounter: number
    totalPruneTokens: number
}

export interface CompressSummary {
    blockId: number
    anchorMessageId: string
    summary: string
}

export interface Prune {
    tools: Map<string, number>
    messages: Map<string, number>
}

export interface PendingManualTrigger {
    sessionId: string
    prompt: string
}

export interface MessageIdState {
    byRawId: Map<string, string>
    byRef: Map<string, string>
    nextRef: number
}

export interface SessionState {
    sessionId: string | null
    isSubAgent: boolean
    manualMode: boolean
    pendingManualTrigger: PendingManualTrigger | null
    prune: Prune
    compressSummaries: CompressSummary[]
    contextLimitAnchors: Set<string>
    turnNudgeAnchors: Set<string>
    stats: SessionStats
    toolParameters: Map<string, ToolParameterEntry>
    toolIdList: string[]
    messageIds: MessageIdState
    lastCompaction: number
    currentTurn: number
    variant: string | undefined
    modelContextLimit: number | undefined
    systemPromptTokens: number | undefined
}
