import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { createDiscardTool, createExtractTool } from "./lib/strategies"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createSystemPromptHandler,
} from "./lib/hooks"

const plugin: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const state = createSessionState()

    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(state, logger, config),

        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            config,
        ),
        "chat.message": async (
            input: {
                sessionID: string
                agent?: string
                model?: { providerID: string; modelID: string }
                messageID?: string
                variant?: string
            },
            _output: any,
        ) => {
            // Cache variant from real user messages (not synthetic)
            // This avoids scanning all messages to find variant
            state.variant = input.variant
            logger.debug("Cached variant from chat.message hook", { variant: input.variant })
        },
        tool: {
            ...(config.tools.discard.enabled && {
                discard: createDiscardTool({
                    client: ctx.client,
                    state,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
            ...(config.tools.extract.enabled && {
                extract: createExtractTool({
                    client: ctx.client,
                    state,
                    logger,
                    config,
                    workingDirectory: ctx.directory,
                }),
            }),
        },
        config: async (opencodeConfig) => {
            if (config.commands) {
                opencodeConfig.command ??= {}
                opencodeConfig.command["dcp"] = {
                    template: "",
                    description: "Show available DCP commands",
                }
            }

            const toolsToAdd: string[] = []
            if (config.tools.discard.enabled) toolsToAdd.push("discard")
            if (config.tools.extract.enabled) toolsToAdd.push("extract")

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
                logger.info(
                    `Added ${toolsToAdd.map((t) => `'${t}'`).join(" and ")} to experimental.primary_tools via config mutation`,
                )
            }
        },
        "command.execute.before": createCommandExecuteHandler(ctx.client, state, logger, config),
    }
}) satisfies Plugin

export default plugin
