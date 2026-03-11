export const LABEL = "DCP"

export const NAMES = {
    slot: "dcp.sidebar",
    routes: {
        panel: "dcp.panel",
    },
    commands: {
        panel: "plugin.dcp.panel",
    },
} as const

export type DcpRouteNames = typeof NAMES
