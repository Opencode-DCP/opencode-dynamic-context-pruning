/** @jsxImportSource @opentui/solid */
import type { TuiPluginInput } from "@opencode-ai/plugin/tui"
import { getConfigForDirectory } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSidebarTopSlot } from "./slots/sidebar-top"
import { NAMES } from "./shared/names"

const tui = async (input: TuiPluginInput) => {
    const config = getConfigForDirectory(process.cwd(), (title, message) => {
        input.api.ui.toast({
            title,
            message,
            variant: "warning",
            duration: 7000,
        })
    })
    if (!config.enabled) return

    const logger = new Logger(config.tui.debug, "tui")

    if (config.tui.sidebar) {
        input.slots.register(
            createSidebarTopSlot(input.client, input.event, input.renderer, NAMES, logger),
        )
    }
}

export default {
    tui,
}
