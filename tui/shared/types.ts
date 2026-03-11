import type { TuiPluginInput } from "@opencode-ai/plugin/tui"
import type {
    MessageStatus as DcpMessageStatus,
    TokenBreakdown as DcpContextBreakdown,
} from "../../lib/analysis/tokens"

export type DcpTuiClient = TuiPluginInput["client"]
export type DcpRouteSource = "sidebar" | "command"

export interface DcpRouteParams {
    session_id?: string
    source?: string
}

export type { DcpContextBreakdown, DcpMessageStatus }

export interface DcpPersistedSummary {
    available: boolean
    activeBlockCount: number
    activeBlockTopics: string[]
    activeBlockTopicTotal: number
    lastUpdated?: string
}

export interface DcpAllTimeStats {
    totalTokensSaved: number
    sessionCount: number
}

export interface DcpContextSnapshot {
    sessionID?: string
    breakdown: DcpContextBreakdown
    persisted: DcpPersistedSummary
    messageStatuses: DcpMessageStatus[]
    allTimeStats: DcpAllTimeStats
    notes: string[]
    loadedAt: number
}
