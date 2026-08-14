import { getConfig } from "./lib/config"
import { createCompressMessageTool, createCompressRangeTool } from "./lib/compress"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    type HostPermissionSnapshot,
} from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { createSessionState } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createContextHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { startAutoUpdate } from "./lib/update"

export const Plugin = {
    define<T extends { id: string; setup: (ctx: any) => any }>(definition: T): T {
        return definition
    },
}

export default Plugin.define({
    id: "opencode-dcp",
    async setup(ctx: any) {
        const config = getConfig(ctx)

        if (!config.enabled) {
            return async () => {}
        }

        const logger = new Logger(config.debug)
        const state = createSessionState()
        const directory = ctx?.directory || (ctx?.app?.workspace?.directory ?? process.cwd())
        const prompts = new PromptStore(logger, directory, config.experimental.customPrompts)
        const hostPermissions: HostPermissionSnapshot = {
            global: undefined,
            agents: {},
        }

        const client = ctx?.client

        if (isSecureMode() && client) {
            configureClientAuth(client)
        }

        logger.info("DCP initialized", {
            strategies: config.strategies,
        })

        startAutoUpdate(ctx, config.autoUpdate)

        const compressToolContext = {
            client,
            state,
            logger,
            config,
            prompts,
        }

        const registrations: Array<{ dispose(): Promise<void> | void }> = []

        // 1. Session context hook (migrates context transformation and pruning)
        if (ctx.session?.hook) {
            const contextHandler = createContextHandler(
                client,
                state,
                logger,
                config,
                prompts,
                hostPermissions,
            )
            const reg = await ctx.session.hook("context", async (event: any) => {
                await contextHandler(event)
            })
            if (reg && typeof reg.dispose === "function") {
                registrations.push(reg)
            }
        }

        // 2. Tool registration (using ctx.tool.transform)
        if (ctx.tool?.transform && config.compress.permission !== "deny") {
            const toolInstance =
                config.compress.mode === "message"
                    ? createCompressMessageTool(compressToolContext)
                    : createCompressRangeTool(compressToolContext)

            const input = {
                type: "object",
                properties: {
                    topic: {
                        type: "string",
                        description:
                            config.compress.mode === "message"
                                ? "Short label (3-5 words) for the overall batch - e.g., 'Closed Research Notes'"
                                : "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
                    },
                    content: {
                        type: "array",
                        description:
                            config.compress.mode === "message"
                                ? "Batch of individual message summaries to create in one tool call"
                                : "One or more ranges to compress, each with start/end boundaries and a summary",
                        items:
                            config.compress.mode === "message"
                                ? {
                                      type: "object",
                                      properties: {
                                          messageId: {
                                              type: "string",
                                              description:
                                                  "Raw message ID to compress (e.g. m0001)",
                                          },
                                          topic: {
                                              type: "string",
                                              description:
                                                  "Short label (3-5 words) for this one message summary",
                                          },
                                          summary: {
                                              type: "string",
                                              description:
                                                  "Complete technical summary replacing that one message",
                                          },
                                      },
                                      required: ["messageId", "topic", "summary"],
                                  }
                                : {
                                      type: "object",
                                      properties: {
                                          startId: {
                                              type: "string",
                                              description:
                                                  "Message or block ID marking the beginning of range (e.g. m0001, b2)",
                                          },
                                          endId: {
                                              type: "string",
                                              description:
                                                  "Message or block ID marking the end of range (e.g. m0012, b5)",
                                          },
                                          summary: {
                                              type: "string",
                                              description:
                                                  "Complete technical summary replacing all content in range",
                                          },
                                      },
                                      required: ["startId", "endId", "summary"],
                                  },
                    },
                },
                required: ["topic", "content"],
            }

            const toolDef = {
                name: "compress",
                description: (toolInstance as any).description,
                input,
                async execute(input: any, toolCtx: any) {
                    const text = await (toolInstance as any).execute(input, toolCtx)
                    return { content: [{ type: "text", text }] }
                },
            }

            const toolReg = await ctx.tool.transform((draft: any) => {
                draft.add(toolDef)
            })
            if (toolReg && typeof toolReg.dispose === "function") {
                registrations.push(toolReg)
            }
        }

        // 3. Command registration (using ctx.command.transform)
        if (
            ctx.command?.transform &&
            config.commands.enabled &&
            config.compress.permission !== "deny"
        ) {
            const commandReg = await ctx.command.transform((draft: any) => {
                if (draft && typeof draft.update === "function") {
                    draft.update("dcp-compress", (cmd: any) => {
                        if (cmd && typeof cmd === "object") {
                            cmd.template = ""
                            cmd.description =
                                "Trigger DCP manual compression with: /dcp-compress [focus]"
                        }
                    })
                }
            })
            if (commandReg && typeof commandReg.dispose === "function") {
                registrations.push(commandReg)
            }
        }

        // 4. Event subscription (using ctx.event.subscribe)
        if (ctx.event?.subscribe) {
            const eventHandler = createEventHandler(state, logger)
            const eventReg = await ctx.event.subscribe(async (event: any) => {
                await eventHandler({ event })
            })
            if (eventReg && typeof eventReg.dispose === "function") {
                registrations.push(eventReg)
            }
        }

        // 5. Cleanup
        return async () => {
            await Promise.all(
                registrations
                    .filter((r) => r && typeof r.dispose === "function")
                    .map((r) => r.dispose()),
            )
        }
    },
})

/** Legacy v1 plugin factory retained for backwards-compatibility */
export const server = async (ctx: any) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const state = createSessionState()
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
    }

    logger.info("DCP initialized", {
        strategies: config.strategies,
    })

    startAutoUpdate(ctx, config.autoUpdate)

    const compressToolContext = {
        client: ctx.client,
        state,
        logger,
        config,
        prompts,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(
            state,
            logger,
            config,
            prompts,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            state,
            logger,
            config,
            prompts,
            hostPermissions,
        ) as any,
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            state,
            logger,
            config,
            ctx.directory,
            hostPermissions,
        ),
        event: createEventHandler(state, logger),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress:
                    config.compress.mode === "message"
                        ? createCompressMessageTool(compressToolContext)
                        : createCompressRangeTool(compressToolContext),
            }),
        },
        config: async (opencodeConfig: any) => {
            if (
                config.compress.permission !== "deny" &&
                compressDisabledByOpencode(opencodeConfig.permission)
            ) {
                config.compress.permission = "deny"
            }

            if (config.commands.enabled && config.compress.permission !== "deny") {
                opencodeConfig.command ??= {}
                opencodeConfig.command["dcp-compress"] = {
                    template: "",
                    description: "Trigger DCP manual compression with: /dcp-compress [focus]",
                }
            }

            const toolsToAdd: string[] = []
            if (config.compress.permission !== "deny" && !config.experimental.allowSubAgents) {
                toolsToAdd.push("compress")
            }

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "compress")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    compress: config.compress.permission,
                } as typeof permission
            }

            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]: [string, any]) => [
                    name,
                    agent?.permission,
                ]),
            )
        },
    }
}
