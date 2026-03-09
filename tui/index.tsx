/** @jsxImportSource @opentui/solid */
import type { TuiPluginInput } from "@opencode-ai/plugin/tui"
import { registerCommands } from "./commands"
import { createPanelRoute } from "./routes/panel"
import { createSidebarTopSlot } from "./slots/sidebar-top"
import { readConfig } from "./shared/config"
import { createNames } from "./shared/names"

const tui = async (input: TuiPluginInput, options?: Record<string, unknown>) => {
    if (options?.enabled === false) return

    const config = readConfig(options)
    const names = createNames(config)

    input.api.route.register([
        createPanelRoute({
            api: input.api,
            config,
            names,
        }),
    ])

    registerCommands(input.api, config, names)
    input.slots.register(createSidebarTopSlot(input.api, input.client, config, names))
}

export default {
    tui,
}
