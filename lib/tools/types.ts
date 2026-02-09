import type { SessionState } from "../state"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"

export interface ToolContext {
    client: any
    state: SessionState
    logger: Logger
    config: PluginConfig
    workingDirectory: string
}
