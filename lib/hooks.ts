import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites, purgeErrors } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { checkSession } from "./state"
import { loadPrompt } from "./prompts"
import { handleStatsCommand } from "./commands/stats"
import { handleContextCommand } from "./commands/context"
import { handleHelpCommand } from "./commands/help"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
]

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (_input: unknown, output: { system: string[] }) => {
        // For sub-agents, check if DCP is enabled via experimental config
        if (state.isSubAgent) {
            if (!state.subAgentState.dcpEnabled) {
                logger.info("Skipping DCP system prompt for sub-agent (not enabled in config)")
                return
            }
            logger.info("Sub-agent DCP enabled, injecting system prompt", {
                matchedAgent: state.subAgentState.matchedConfig?.name,
            })
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        // Determine which tools are enabled for this session
        let discardEnabled = config.tools.discard.enabled
        let extractEnabled = config.tools.extract.enabled

        // For sub-agents, check if tools are overridden in the config
        if (state.isSubAgent && state.subAgentState.matchedConfig?.config.tools) {
            const toolsOverride = state.subAgentState.matchedConfig.config.tools
            if (toolsOverride.discard?.enabled !== undefined) {
                discardEnabled = toolsOverride.discard.enabled
            }
            if (toolsOverride.extract?.enabled !== undefined) {
                extractEnabled = toolsOverride.extract.enabled
            }
        }

        let promptName: string
        if (discardEnabled && extractEnabled) {
            promptName = "system/system-prompt-both"
        } else if (discardEnabled) {
            promptName = "system/system-prompt-discard"
        } else if (extractEnabled) {
            promptName = "system/system-prompt-extract"
        } else {
            return
        }

        const syntheticPrompt = loadPrompt(promptName)
        output.system.push(syntheticPrompt)
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        await checkSession(client, state, logger, config, output.messages)

        // For sub-agents, check if DCP is enabled via experimental config
        if (state.isSubAgent && !state.subAgentState.dcpEnabled) {
            logger.debug("Skipping DCP for sub-agent (not enabled in config)")
            return
        }

        // Get effective config for this session (may have sub-agent overrides)
        const effectiveConfig = getEffectiveConfig(config, state)

        syncToolCache(state, effectiveConfig, logger, output.messages)

        deduplicate(state, logger, effectiveConfig, output.messages)
        supersedeWrites(state, logger, effectiveConfig, output.messages)
        purgeErrors(state, logger, effectiveConfig, output.messages)

        prune(state, logger, effectiveConfig, output.messages)

        insertPruneToolContext(state, effectiveConfig, logger, output.messages)

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

// Get effective config with sub-agent overrides applied
function getEffectiveConfig(config: PluginConfig, state: SessionState): PluginConfig {
    if (!state.isSubAgent || !state.subAgentState.matchedConfig) {
        return config
    }

    const agentConfig = state.subAgentState.matchedConfig.config

    // Create a copy of the config with sub-agent overrides
    const effectiveConfig: PluginConfig = {
        ...config,
        tools: {
            ...config.tools,
            settings: {
                ...config.tools.settings,
                // For sub-agents, only the tools defined in prunableTools should be prunable
                // All other tools should be protected
                protectedTools: [
                    ...config.tools.settings.protectedTools,
                ],
            },
            discard: {
                ...config.tools.discard,
                ...(agentConfig.tools?.discard || {}),
            },
            extract: {
                ...config.tools.extract,
                ...(agentConfig.tools?.extract || {}),
            },
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                enabled:
                    agentConfig.strategies?.deduplication?.enabled ??
                    config.strategies.deduplication.enabled,
            },
            supersedeWrites: {
                ...config.strategies.supersedeWrites,
                enabled:
                    agentConfig.strategies?.supersedeWrites?.enabled ??
                    config.strategies.supersedeWrites.enabled,
            },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                enabled:
                    agentConfig.strategies?.purgeErrors?.enabled ??
                    config.strategies.purgeErrors.enabled,
                turns:
                    agentConfig.strategies?.purgeErrors?.turns ??
                    config.strategies.purgeErrors.turns,
            },
        },
    }

    return effectiveConfig
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        _output: { parts: any[] },
    ) => {
        if (!config.commands) {
            return
        }

        if (input.command === "dcp") {
            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = args[0]?.toLowerCase() || ""
            const _subArgs = args.slice(1)

            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = (messagesResponse.data || messagesResponse) as WithParts[]

            if (subcommand === "context") {
                await handleContextCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__DCP_CONTEXT_HANDLED__")
            }

            if (subcommand === "stats") {
                await handleStatsCommand({
                    client,
                    state,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                })
                throw new Error("__DCP_STATS_HANDLED__")
            }

            await handleHelpCommand({
                client,
                state,
                logger,
                sessionId: input.sessionID,
                messages,
            })
            throw new Error("__DCP_HELP_HANDLED__")
        }
    }
}
