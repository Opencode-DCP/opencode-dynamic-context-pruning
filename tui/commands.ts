import type { TuiApi } from "@opencode-ai/plugin/tui"
import { openPanel } from "./shared/navigation"
import type { DcpRouteNames, DcpTuiConfig } from "./shared/types"

export const registerCommands = (api: TuiApi, config: DcpTuiConfig, names: DcpRouteNames) => {
    const keys = api.keybind?.create({ close: "escape,ctrl+h" })
    api.command.register(() => [
        {
            title: `${config.label} panel`,
            value: names.commands.panel,
            description: "Open the DCP placeholder panel",
            category: config.label,
            ...(keys ? { keybind: keys.get("close") } : {}),
            slash: {
                name: "dcp-panel",
            },
            onSelect: () => openPanel(api, names, "command"),
        },
    ])
}
