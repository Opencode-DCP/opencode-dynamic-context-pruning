// @ts-nocheck
import type { TuiApi } from "@opencode-ai/plugin/tui"
import { openPanel } from "./shared/navigation"
import type { DcpRouteNames, DcpTuiConfig } from "./shared/types"

export const registerCommands = (api: TuiApi, config: DcpTuiConfig, names: DcpRouteNames) => {
    api.command.register(() => [
        {
            title: `${config.label} panel`,
            value: names.commands.panel,
            description: "Open the DCP placeholder panel",
            category: config.label,
            slash: {
                name: "dcp-panel",
            },
            onSelect: () => openPanel(api, names, "command"),
        },
    ])
}
