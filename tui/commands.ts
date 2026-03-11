import type { TuiApi } from "@opencode-ai/plugin/tui"
import { openPanel } from "./shared/navigation"
import { LABEL, type DcpRouteNames } from "./shared/names"

export const registerCommands = (api: TuiApi, names: DcpRouteNames) => {
    const keys = api.keybind?.create({ close: "escape" })
    api.command.register(() => [
        {
            title: `${LABEL} panel`,
            value: names.commands.panel,
            description: "Open the DCP placeholder panel",
            category: LABEL,
            ...(keys ? { keybind: keys.get("close") } : {}),
            slash: {
                name: "dcp-panel",
            },
            onSelect: () => openPanel(api, names, "command"),
        },
    ])
}
