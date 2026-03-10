/** @jsxImportSource @opentui/solid */
import type { TuiPluginInput } from "@opencode-ai/plugin/tui"
import { Logger } from "../lib/logger"
import { registerCommands } from "./commands"
import { setContextLogger } from "./data/context"
import { createPanelRoute } from "./routes/panel"
import { createSidebarTopSlot } from "./slots/sidebar-top"
import { readConfig } from "./shared/config"
import { createNames } from "./shared/names"

const tui = async (input: TuiPluginInput, options?: Record<string, unknown>) => {
    if (options?.enabled === false) return

    const config = readConfig(options)
    const names = createNames(config)
    const logger = new Logger(config.debug, "TUI")

    setContextLogger(logger)
    void logger.info("DCP TUI initialized", {
        debug: config.debug,
        label: config.label,
        route: config.route,
    })

    input.api.route.register([
        createPanelRoute({
            api: input.api,
            config,
            names,
        }),
    ])

    registerCommands(input.api, config, names)
    input.slots.register(
        createSidebarTopSlot(
            input.api,
            input.client,
            input.event,
            input.renderer,
            logger,
            config,
            names,
        ),
    )
}

export default {
    tui,
}
