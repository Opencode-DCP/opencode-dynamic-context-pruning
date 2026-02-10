import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { syncToolCache } from "./state/tool-cache"
import { deduplicate, supersedeWrites, purgeErrors } from "./strategies"
import { prune, insertPruneToolContext } from "./messages"
import { buildToolIdList } from "./messages/utils"
import { buildPrunableToolsList } from "./messages/inject"
import { checkSession } from "./state"
import { renderSystemPrompt } from "./prompts"
import { handleStatsCommand } from "./commands/stats"
import { handleContextCommand } from "./commands/context"
import { handleHelpCommand } from "./commands/help"
import { handleSweepCommand } from "./commands/sweep"
import { ensureSessionInitialized } from "./state/state"
import { sendIgnoredMessage } from "./ui/notification"
import { getCurrentParams } from "./strategies/utils"

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
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        }

        if (state.isSubAgent) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        const flags = {
            prune: config.tools.prune.permission !== "deny",
            distill: config.tools.distill.permission !== "deny",
            compress: config.tools.compress.permission !== "deny",
            manual: state.manualMode,
        }

        if (!flags.prune && !flags.distill && !flags.compress) {
            return
        }

        output.system.push(renderSystemPrompt(flags))
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

        if (state.isSubAgent) {
            return
        }

        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages, logger)

        const shouldApplyStrategies = !state.manualMode || config.manualMode.automaticStrategies
        if (shouldApplyStrategies) {
            deduplicate(state, logger, config, output.messages)
            supersedeWrites(state, logger, config, output.messages)
            purgeErrors(state, logger, config, output.messages)
        }

        prune(state, logger, config, output.messages)

        if (!state.manualMode) {
            insertPruneToolContext(state, config, logger, output.messages)
        }

        if (state.sessionId) {
            await logger.saveContext(state.sessionId, output.messages)
        }
    }
}

export function createCommandExecuteHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    workingDirectory: string,
) {
    const getManualCommandMessage = (manualMode: boolean): string => {
        return manualMode
            ? "Manual mode is now ON. Automatic context injection is disabled; use /dcp prune, /dcp distill, or /dcp compress to trigger context tools manually."
            : "Manual mode is now OFF. Automatic context injection is enabled again."
    }

    const getManualTriggerPrompt = (
        tool: "prune" | "distill" | "compress",
        context?: string,
    ): string => {
        if (tool === "prune") {
            return [
                "<prune triggered manually>",
                "Manual mode trigger received. You must now use the prune tool exactly once.",
                "Find the most significant set of prunable tool outputs to remove safely.",
                "Follow prune policy and avoid pruning outputs that may be needed later.",
                "Return after prune with a brief explanation of what you pruned and why.",
                context,
            ]
                .filter(Boolean)
                .join("\n\n")
        }

        if (tool === "distill") {
            return [
                "<distill triggered manually>",
                "Manual mode trigger received. You must now use the distill tool.",
                "Select the most information-dense prunable outputs and distill them into complete technical substitutes.",
                "Be exhaustive and preserve all critical technical details.",
                "Return after distill with a brief explanation of what was distilled and why.",
                context,
            ]
                .filter(Boolean)
                .join("\n\n")
        }

        return [
            "<compress triggered manually>",
            "Manual mode trigger received. You must now use the compress tool.",
            "Find the most significant completed section of the conversation that can be compressed into a high-fidelity technical summary.",
            "Choose safe boundaries and preserve all critical implementation details.",
            "Return after compress with a brief explanation of what range was compressed.",
        ].join("\n\n")
    }

    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = (messagesResponse.data || messagesResponse) as WithParts[]

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
            )

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const subcommand = args[0]?.toLowerCase() || ""
            const subArgs = args.slice(1)
            const params = getCurrentParams(state, messages, logger)

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

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    client,
                    state,
                    config,
                    logger,
                    sessionId: input.sessionID,
                    messages,
                    args: subArgs,
                    workingDirectory,
                })
                throw new Error("__DCP_SWEEP_HANDLED__")
            }

            if (subcommand === "manual") {
                const modeArg = subArgs[0]?.toLowerCase()
                if (modeArg === "on") {
                    state.manualMode = true
                } else if (modeArg === "off") {
                    state.manualMode = false
                } else {
                    state.manualMode = !state.manualMode
                }

                await sendIgnoredMessage(
                    client,
                    input.sessionID,
                    getManualCommandMessage(state.manualMode),
                    params,
                    logger,
                )
                throw new Error("__DCP_MANUAL_HANDLED__")
            }

            if (subcommand === "prune" || subcommand === "distill" || subcommand === "compress") {
                if (!state.manualMode) {
                    await sendIgnoredMessage(
                        client,
                        input.sessionID,
                        "Manual mode is OFF. Run /dcp manual on to use manual tool triggers.",
                        params,
                        logger,
                    )
                    throw new Error("__DCP_MANUAL_OFF__")
                }

                const toolPermission = config.tools[subcommand].permission
                if (toolPermission === "deny") {
                    await sendIgnoredMessage(
                        client,
                        input.sessionID,
                        `The ${subcommand} tool is disabled by config (permission=deny).`,
                        params,
                        logger,
                    )
                    throw new Error("__DCP_TOOL_DISABLED__")
                }

                if (subcommand === "prune" || subcommand === "distill") {
                    syncToolCache(state, config, logger, messages)
                    buildToolIdList(state, messages, logger)
                    const prunableToolsList = buildPrunableToolsList(state, config, logger)
                    if (!prunableToolsList) {
                        await sendIgnoredMessage(
                            client,
                            input.sessionID,
                            "No prunable tool outputs are currently available for manual triggering.",
                            params,
                            logger,
                        )
                        throw new Error("__DCP_NO_PRUNABLE_TOOLS__")
                    }

                    output.parts = [
                        {
                            type: "text",
                            text: getManualTriggerPrompt(subcommand, prunableToolsList),
                        },
                    ]
                    return
                }

                output.parts = [
                    {
                        type: "text",
                        text: getManualTriggerPrompt("compress"),
                    },
                ]
                return
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
