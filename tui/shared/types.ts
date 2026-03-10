import type { TuiPluginInput } from "@opencode-ai/plugin/tui"

export type DcpTuiClient = TuiPluginInput["client"]
export type DcpRouteSource = "sidebar" | "command"

export interface DcpTuiConfig {
    debug: boolean
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

export {
    type TokenBreakdown as DcpContextBreakdown,
    type MessageStatus as DcpMessageStatus,
} from "../../lib/analysis/tokens"

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
