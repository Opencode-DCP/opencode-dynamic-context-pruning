import type { SessionState, WithParts } from "./state"
import type { Logger } from "./logger"
import type { PluginConfig } from "./config"
import { assignMessageRefs } from "./message-ids"
import {
    buildPriorityMap,
    buildToolIdList,
    injectCompressNudges,
    injectExtendedSubAgentResults,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./messages"
import { renderSystemPrompt, type PromptStore } from "./prompts"
import { buildProtectedToolsExtension } from "./prompts/extensions/system"
import {
    applyPendingCompressionDurations,
    buildCompressionTimingKey,
    consumeCompressionStart,
    resolveCompressionDuration,
} from "./compress/timing"
import { filterMessages, filterMessagesInPlace } from "./messages/shape"
import {
    applyPendingManualTrigger,
    handleContextCommand,
    handleDecompressCommand,
    handleHelpCommand,
    handleManualToggleCommand,
    handleManualTriggerCommand,
    handleRecompressCommand,
    handleStatsCommand,
    handleSweepCommand,
} from "./commands"
import { type HostPermissionSnapshot } from "./host-permissions"
import { compressPermission, syncCompressPermissionState } from "./compress-permission"
import { checkSession, ensureSessionInitialized, saveSessionState, syncToolCache } from "./state"
import { cacheSystemPromptTokens } from "./ui/utils"

const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "You are an anchored context summarization assistant for coding sessions",
    "Summarize what was done in this conversation",
]

// Caches provider/model -> context window size resolved via `client.model.list()`.
// The v2 `session.hook("context")` event only carries a `Model.Ref`
// (id/providerID/variant), never the full `Model.Info.limit.context` that v1's
// chat hooks received directly, so percentage-based `maxContextLimit`/
// `minContextLimit` configs need this looked up out-of-band at least once per
// provider/model pair.
const modelContextLimitCache = new Map<string, number>()

export async function resolveModelContextLimit(
    client: any,
    providerID: string | undefined,
    modelID: string | undefined,
): Promise<number | undefined> {
    if (!providerID || !modelID || typeof client?.model?.list !== "function") {
        return undefined
    }

    const cacheKey = `${providerID}/${modelID}`
    const cached = modelContextLimitCache.get(cacheKey)
    if (cached !== undefined) {
        return cached
    }

    try {
        const response = await client.model.list()
        const models = (response?.data ?? response ?? []) as any[]
        for (const model of models) {
            const context = model?.limit?.context
            if (typeof context !== "number") {
                continue
            }
            const key = `${model.providerID}/${model.modelID ?? model.id}`
            modelContextLimitCache.set(key, context)
        }
    } catch {
        return undefined
    }

    return modelContextLimitCache.get(cacheKey)
}

export function createSystemPromptHandler(
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
) {
    return async (
        input: { sessionID?: string; model: { limit: { context: number } } },
        output: { system: string[] },
    ) => {
        if (input.model?.limit?.context) {
            state.modelContextLimit = input.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        }

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        const systemText = output.system.join("\n")
        if (INTERNAL_AGENT_SIGNATURES.some((sig) => systemText.includes(sig))) {
            logger.info("Skipping DCP system prompt injection for internal agent")
            return
        }

        const effectivePermission =
            input.sessionID && state.sessionId === input.sessionID
                ? compressPermission(state, config)
                : config.compress.permission

        if (effectivePermission === "deny") {
            return
        }

        prompts.reload()
        const runtimePrompts = prompts.getRuntimePrompts()
        const baseSystemPrompt = runtimePrompts.system.trim()
        if (baseSystemPrompt && systemText.includes(baseSystemPrompt)) {
            logger.info("Skipping DCP system prompt injection (already present in system prompt)")
            return
        }

        const newPrompt = renderSystemPrompt(
            runtimePrompts,
            buildProtectedToolsExtension(config.compress.protectedTools),
            !!state.manualMode,
            state.isSubAgent && config.experimental.allowSubAgents,
        )
        if (output.system.length > 0) {
            output.system[output.system.length - 1] += "\n\n" + newPrompt
        } else {
            output.system.push(newPrompt)
        }
    }
}

export interface ContextHookEvent {
    sessionID?: string
    agent?: string
    model?: any
    system?: any[]
    messages?: WithParts[]
    tools?: Record<string, any>
}

export function createContextHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    const systemHandler = createSystemPromptHandler(state, logger, config, prompts)
    const chatHandler = createChatMessageTransformHandler(
        client,
        state,
        logger,
        config,
        prompts,
        hostPermissions,
    )

    return async (event: ContextHookEvent) => {
        if (event.model?.limit?.context) {
            state.modelContextLimit = event.model.limit.context
            logger.debug("Cached model context limit", { limit: state.modelContextLimit })
        } else if (state.modelContextLimit === undefined) {
            const resolved = await resolveModelContextLimit(
                client,
                event.model?.providerID,
                event.model?.id,
            )
            if (resolved !== undefined) {
                state.modelContextLimit = resolved
                logger.debug("Resolved model context limit via model catalog", {
                    limit: resolved,
                })
            }
        }

        if (event.system && Array.isArray(event.system)) {
            const isObjectSystem = event.system.length > 0 && typeof event.system[0] === "object"
            if (isObjectSystem) {
                const stringArray = event.system.map((s: any) =>
                    typeof s === "string" ? s : (s?.text ?? ""),
                )
                const tempOutput = { system: stringArray }
                await systemHandler({ sessionID: event.sessionID, model: event.model }, tempOutput)
                if (tempOutput.system.length > stringArray.length) {
                    for (let i = stringArray.length; i < tempOutput.system.length; i++) {
                        event.system.push({ type: "text", text: tempOutput.system[i] })
                    }
                }
                if (tempOutput.system.length > 0 && event.system.length > 0) {
                    const lastTemp = tempOutput.system[stringArray.length - 1]
                    const origLast = stringArray[stringArray.length - 1]
                    if (lastTemp !== origLast) {
                        const target = event.system[stringArray.length - 1]
                        if (typeof target === "string") {
                            event.system[stringArray.length - 1] = lastTemp
                        } else if (target && typeof target === "object") {
                            target.text = lastTemp
                        }
                    }
                }
            } else {
                const tempOutput = { system: event.system }
                await systemHandler(
                    { sessionID: event.sessionID, model: event.model },
                    tempOutput as any,
                )
            }
        }

        if (event.messages && Array.isArray(event.messages)) {
            const v2Meta = new Map<
                any,
                {
                    wasArray: boolean
                    originalContent: any
                    hadSyntheticInfo: boolean
                    hadSyntheticParts: boolean
                }
            >()
            for (let i = 0; i < event.messages.length; i++) {
                const msg = event.messages[i] as any
                if (!msg || typeof msg !== "object") continue

                const wasArray = Array.isArray(msg.content)
                const hadSyntheticInfo = !msg.info || typeof msg.info !== "object"
                const hadSyntheticParts = !Array.isArray(msg.parts)

                v2Meta.set(msg, {
                    wasArray,
                    originalContent: msg.content,
                    hadSyntheticInfo,
                    hadSyntheticParts,
                })

                if (hadSyntheticInfo) {
                    msg.info = {
                        id: msg.id ?? `m${i.toString().padStart(4, "0")}`,
                        sessionID: event.sessionID ?? state.sessionId ?? "default",
                        role: msg.role ?? "user",
                        time: { created: Date.now() - (event.messages.length - i) * 1000 },
                    }
                }
                if (hadSyntheticParts) {
                    if (Array.isArray(msg.content)) {
                        msg.parts = msg.content
                    } else if (msg.role === "tool" || msg.tool_call_id) {
                        msg.parts = [
                            {
                                type: "tool",
                                callID: msg.tool_call_id ?? msg.id ?? `call_${i}`,
                                state: {
                                    status: "completed",
                                    output:
                                        typeof msg.content === "string"
                                            ? msg.content
                                            : JSON.stringify(msg.content ?? ""),
                                },
                            },
                        ]
                    } else if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
                        msg.parts = []
                        if (typeof msg.content === "string" && msg.content.length > 0) {
                            msg.parts.push({ type: "text", text: msg.content })
                        }
                        for (const tc of msg.tool_calls) {
                            msg.parts.push({
                                type: "tool",
                                tool: tc.function?.name ?? tc.name ?? "unknown",
                                callID: tc.id,
                                state: {
                                    status: "running",
                                    input: tc.function?.arguments ?? tc.arguments,
                                },
                            })
                        }
                    } else if (typeof msg.content === "string") {
                        msg.parts = [{ type: "text", text: msg.content }]
                    } else {
                        msg.parts = []
                    }
                }
            }

            await chatHandler({ sessionID: event.sessionID }, { messages: event.messages })

            for (const [msg, meta] of v2Meta.entries()) {
                if (!msg) continue
                if (meta.wasArray) {
                    msg.content = msg.parts
                } else if (typeof meta.originalContent === "string") {
                    const textParts = (msg.parts || [])
                        .filter((p: any) => p.type === "text")
                        .map((p: any) => p.text ?? "")
                    if (textParts.length > 0) {
                        msg.content = textParts.join("\n")
                    } else if (msg.role === "tool") {
                        const toolPart = (msg.parts || []).find((p: any) => p.type === "tool")
                        if (toolPart?.state?.output !== undefined) {
                            msg.content =
                                typeof toolPart.state.output === "string"
                                    ? toolPart.state.output
                                    : JSON.stringify(toolPart.state.output)
                        }
                    }
                }
                if (meta.hadSyntheticInfo) {
                    delete msg.info
                }
                if (meta.hadSyntheticParts && !meta.wasArray) {
                    delete msg.parts
                }
            }
        }
    }
}

export function createChatMessageTransformHandler(
    client: any,
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    prompts: PromptStore,
    hostPermissions: HostPermissionSnapshot,
) {
    return async (input: {}, output: { messages: WithParts[] }) => {
        const receivedMessages = Array.isArray(output.messages) ? output.messages.length : 0
        const messages = filterMessagesInPlace(output.messages)
        if (messages.length !== receivedMessages) {
            logger.warn("Skipping messages with unexpected shape during chat transform", {
                received: receivedMessages,
                usable: messages.length,
            })
        }

        await checkSession(client, state, logger, output.messages, config.manualMode.enabled)

        syncCompressPermissionState(state, config, hostPermissions, output.messages)

        if (state.isSubAgent && !config.experimental.allowSubAgents) {
            return
        }

        stripHallucinations(output.messages)
        cacheSystemPromptTokens(state, output.messages)
        assignMessageRefs(state, output.messages)
        syncCompressionBlocks(state, logger, output.messages)
        syncToolCache(state, config, logger, output.messages)
        buildToolIdList(state, output.messages)
        prune(state, logger, config, output.messages)
        await injectExtendedSubAgentResults(
            client,
            state,
            logger,
            output.messages,
            config.experimental.allowSubAgents,
        )
        const compressionPriorities = buildPriorityMap(config, state, output.messages)
        prompts.reload()
        injectCompressNudges(
            state,
            config,
            logger,
            output.messages,
            prompts.getRuntimePrompts(),
            compressionPriorities,
        )
        injectMessageIds(state, config, output.messages, compressionPriorities)
        applyPendingManualTrigger(state, output.messages, logger)
        stripStaleMetadata(output.messages)

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
    hostPermissions: HostPermissionSnapshot,
) {
    return async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
    ) => {
        if (!config.commands.enabled) {
            return
        }

        if (input.command === "dcp" || input.command === "dcp-compress") {
            const messagesResponse = await client.session.messages({
                path: { id: input.sessionID },
            })
            const messages = filterMessages(messagesResponse.data || messagesResponse)

            await ensureSessionInitialized(
                client,
                state,
                input.sessionID,
                logger,
                messages,
                config.manualMode.enabled,
            )

            syncCompressPermissionState(state, config, hostPermissions, messages)

            const effectivePermission = compressPermission(state, config)
            if (effectivePermission === "deny") {
                return
            }

            const args = (input.arguments || "").trim().split(/\s+/).filter(Boolean)
            const isCompressCommand = input.command === "dcp-compress"
            const subcommand = isCompressCommand ? "compress" : args[0]?.toLowerCase() || ""
            const subArgs = isCompressCommand ? args : args.slice(1)

            const commandCtx = {
                client,
                state,
                config,
                logger,
                sessionId: input.sessionID,
                messages,
            }

            if (subcommand === "context") {
                await handleContextCommand(commandCtx)
                return
            }

            if (subcommand === "stats") {
                await handleStatsCommand(commandCtx)
                return
            }

            if (subcommand === "sweep") {
                await handleSweepCommand({
                    ...commandCtx,
                    args: subArgs,
                    workingDirectory,
                })
                return
            }

            if (subcommand === "manual") {
                await handleManualToggleCommand(commandCtx, subArgs[0]?.toLowerCase())
                return
            }

            if (subcommand === "compress") {
                const userFocus = subArgs.join(" ").trim()
                const prompt = await handleManualTriggerCommand(commandCtx, "compress", userFocus)
                if (!prompt) {
                    throw new Error("__DCP_MANUAL_TRIGGER_BLOCKED__")
                }

                state.manualMode = "compress-pending"
                state.pendingManualTrigger = {
                    sessionId: input.sessionID,
                    prompt,
                }
                const rawArgs = (input.arguments || "").trim()
                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: isCompressCommand
                        ? rawArgs
                            ? `/dcp-compress ${rawArgs}`
                            : "/dcp-compress"
                        : rawArgs
                          ? `/dcp ${rawArgs}`
                          : `/dcp ${subcommand}`,
                })
                return
            }

            if (subcommand === "decompress") {
                await handleDecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            if (subcommand === "recompress") {
                await handleRecompressCommand({
                    ...commandCtx,
                    args: subArgs,
                })
                return
            }

            await handleHelpCommand(commandCtx)
            return
        }
    }
}

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ) => {
        output.text = stripHallucinationsFromString(output.text)
    }
}

export function createEventHandler(state: SessionState, logger: Logger) {
    return async (input: { event: any }) => {
        const eventTime =
            typeof input.event?.time === "number" && Number.isFinite(input.event.time)
                ? input.event.time
                : typeof input.event?.properties?.time === "number" &&
                    Number.isFinite(input.event.properties.time)
                  ? input.event.properties.time
                  : undefined

        if (input.event.type !== "message.part.updated") {
            return
        }

        const part = input.event.properties?.part
        if (part?.type !== "tool" || part.tool !== "compress") {
            return
        }

        if (part.state.status === "pending") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const startedAt = eventTime ?? Date.now()
            const key = buildCompressionTimingKey(part.messageID, part.callID)
            if (state.compressionTiming.startsByCallId.has(key)) {
                return
            }
            state.compressionTiming.startsByCallId.set(key, startedAt)
            logger.debug("Recorded compression start", {
                messageID: part.messageID,
                callID: part.callID,
                startedAt,
            })
            return
        }

        if (part.state.status === "completed") {
            if (typeof part.callID !== "string" || typeof part.messageID !== "string") {
                return
            }

            const key = buildCompressionTimingKey(part.messageID, part.callID)
            const start = consumeCompressionStart(state, part.messageID, part.callID)
            const durationMs = resolveCompressionDuration(start, eventTime, part.state.time)
            if (typeof durationMs !== "number") {
                return
            }

            state.compressionTiming.pendingByCallId.set(key, {
                messageId: part.messageID,
                callId: part.callID,
                durationMs,
            })

            const updates = applyPendingCompressionDurations(state)
            if (updates === 0) {
                return
            }

            await saveSessionState(state, logger)

            logger.info("Attached compression time to blocks", {
                messageID: part.messageID,
                callID: part.callID,
                blocks: updates,
                durationMs,
            })
            return
        }

        if (part.state.status === "running") {
            return
        }

        if (typeof part.callID === "string" && typeof part.messageID === "string") {
            state.compressionTiming.startsByCallId.delete(
                buildCompressionTimingKey(part.messageID, part.callID),
            )
        }
    }
}
