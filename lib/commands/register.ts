import type { PluginConfig } from "./config"

type OpencodeCommandConfig = {
    template: string
    description: string
}

type OpencodeConfig = {
    command?: Record<string, OpencodeCommandConfig>
}

export function registerOpencodeCommands(
    opencodeConfig: OpencodeConfig,
    config: PluginConfig,
): void {
    if (!config.commands.enabled || config.compress.permission === "deny") {
        return
    }

    opencodeConfig.command ??= {}
    opencodeConfig.command["dcp"] = {
        template: "",
        description:
            "DCP context management: /dcp stats, /dcp context, /dcp sweep, /dcp manual, /dcp decompress, /dcp recompress",
    }
    opencodeConfig.command["dcp-compress"] = {
        template: "",
        description: "Trigger DCP manual compression with: /dcp-compress [focus]",
    }
}
