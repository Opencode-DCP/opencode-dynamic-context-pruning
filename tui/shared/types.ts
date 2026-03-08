// @ts-nocheck
import type { TuiPluginInput } from "@opencode-ai/plugin/tui"

export type DcpTuiClient = TuiPluginInput["client"]
export type DcpRouteSource = "sidebar" | "command"

export interface DcpTuiConfig {
    label: string
    route: string
}

export interface DcpRouteNames {
    slot: string
    routes: {
        panel: string
    }
    commands: {
        panel: string
    }
}

export interface DcpRouteParams {
    session_id?: string
    source?: string
}

export interface DcpContextBreakdown {
    system: number
    user: number
    assistant: number
    tools: number
    toolCount: number
    toolsInContextCount: number
    prunedTokens: number
    prunedToolCount: number
    prunedMessageCount: number
    total: number
    messageCount: number
}

export interface DcpPersistedSummary {
    available: boolean
    activeBlockCount: number
    activeBlockTopics: string[]
    lastUpdated?: string
}

export interface DcpContextSnapshot {
    sessionID?: string
    breakdown: DcpContextBreakdown
    persisted: DcpPersistedSummary
    notes: string[]
    loadedAt: number
}
