export const LABEL = "DCP"

export const NAMES = {
    slot: "dcp.sidebar",
    routes: {
        summary: "dcp.summary",
    },
} as const

export type DcpRouteNames = typeof NAMES
