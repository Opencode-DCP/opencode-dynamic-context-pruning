import type { DcpRouteNames, DcpTuiConfig } from "./types"

export const createNames = (config: DcpTuiConfig): DcpRouteNames => {
    return {
        slot: `${config.route}.sidebar`,
        routes: {
            panel: `${config.route}.panel`,
        },
        commands: {
            panel: `plugin.${config.route}.panel`,
        },
    }
}
