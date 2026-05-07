import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type {
    MessageStatus as DcpMessageStatus,
    TokenBreakdown as DcpContextBreakdown,
} from "../../lib/analysis/tokens"

export type DcpTuiApi = TuiPluginApi
export type DcpTuiClient = DcpTuiApi["client"]

export type { DcpMessageStatus }

export interface DcpActiveBlockInfo {
    topic: string
    summary: string
}

export interface DcpPersistedSummary {
    available: boolean
    activeBlockCount: number
    activeBlocks: DcpActiveBlockInfo[]
    lastUpdated?: string
}

export interface DcpAllTimeStats {
    totalTokensSaved: number
    sessionCount: number
}

export interface DcpContextSnapshot {
    sessionID?: string
    breakdown: DcpContextBreakdown
    activeSummaryTokens: number
    persisted: DcpPersistedSummary
    messageStatuses: DcpMessageStatus[]
    allTimeStats: DcpAllTimeStats
    notes: string[]
    loadedAt: number
}
