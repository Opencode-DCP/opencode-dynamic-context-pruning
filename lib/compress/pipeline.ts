import type { WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

const TOOL_PAYLOAD_LIMIT = 3000
const TRUNCATION_MARKER = "\n...[truncated]...\n"

function stringifyForCompression(value: unknown): string {
    if (typeof value === "string") return value
    if (value === undefined) return ""

    try {
        const seen = new WeakSet<object>()

        return JSON.stringify(
            value,
            (_key, val) => {
                if (typeof val === "bigint") return val.toString()
                if (typeof val === "object" && val !== null) {
                    if (seen.has(val)) return "[Circular]"
                    seen.add(val)
                }
                return val
            },
            2,
        )
    } catch {
        return String(value)
    }
}

function truncateMiddle(value: string, limit = TOOL_PAYLOAD_LIMIT): string {
    if (value.length <= limit) return value

    const available = Math.max(0, limit - TRUNCATION_MARKER.length)
    const headLength = Math.ceil(available / 2)
    const tailLength = Math.floor(available / 2)

    return `${value.slice(0, headLength)}${TRUNCATION_MARKER}${value.slice(value.length - tailLength)}`
}

export function formatPartForDelegatedCompression(part: any): string {
    if (!part || typeof part !== "object") return ""

    if (part.type === "text") {
        return typeof part.text === "string" ? part.text : stringifyForCompression(part.text)
    }

    if (part.type === "tool") {
        const state = part.state && typeof part.state === "object" ? part.state : {}
        const status = typeof state.status === "string" ? state.status : "unknown"
        const toolName = typeof part.tool === "string" ? part.tool : "unknown"
        const args = stringifyForCompression(state.input ?? {})

        if (status === "completed") {
            return `[Tool: ${toolName} status=completed]\nargs: ${args}\noutput:\n${truncateMiddle(
                stringifyForCompression(state.output),
            )}`
        }

        if (status === "error") {
            return `[Tool: ${toolName} status=error]\nargs: ${args}\nerror:\n${truncateMiddle(
                stringifyForCompression(state.error),
            )}`
        }

        return `[Tool: ${toolName} status=${status}]\nargs: ${args}`
    }

    if (typeof part.prompt === "string") {
        return part.prompt
    }

    return ""
}

export type CompressionDelegate =
    | {
          enabled: false
      }
    | {
          enabled: true
          agent?: string
          model?: {
              providerID: string
              modelID: string
          }
      }

export function resolveCompressionDelegate(config: any): CompressionDelegate {
    if (config.compress.agent) {
        return {
            enabled: true,
            agent: config.compress.agent,
            model: config.compress.model
                ? {
                      providerID: config.compress.model.split("/")[0],
                      modelID: config.compress.model.split("/").slice(1).join("/"),
                  }
                : undefined,
        }
    }

    if (config.compress.model) {
        return {
            enabled: true,
            model: {
                providerID: config.compress.model.split("/")[0],
                modelID: config.compress.model.split("/").slice(1).join("/"),
            },
        }
    }

    return { enabled: false }
}

export async function generateDelegatedSummary(
    client: any,
    logger: any,
    delegate: CompressionDelegate & { enabled: true },
    systemPrompt: string,
    rawText: string
): Promise<string> {
    let helperSession: any | undefined
    
    try {
        helperSession = await client.session.create({
            body: { title: "DCP Compression helper" }
        })
        
        const internalSessionIdsModule = await import("../state")
        internalSessionIdsModule.INTERNAL_SESSION_IDS.add(helperSession.data.id || helperSession.id)

        const body: any = {
            system: systemPrompt,
            tools: {
                compress: false,
                bash: false,
                edit: false,
                write: false,
                read: false,
                webfetch: false,
            },
            parts: [{ type: "text", text: rawText }],
        }

        if (delegate.model) {
            body.model = delegate.model
        }
        if (delegate.agent) {
            body.agent = delegate.agent
        }

        const response = await client.session.prompt({
            path: { id: helperSession.data.id || helperSession.id },
            body,
        })

        if (!response?.data) {
            throw new Error("No response data from compression model")
        }

        const info = response.data.info
        if (info?.error) {
            throw new Error(`Compression model error: ${JSON.stringify(info.error)}`)
        }

        const parts = response.data.parts || []
        const textParts = parts.filter((p: any) => p.type === "text").map((p: any) => p.text)
        
        if (textParts.length === 0) {
            throw new Error("Compression model returned empty text")
        }

        return textParts.join("\n")
    } finally {
        if (helperSession) {
            const helperId = helperSession.data?.id || helperSession.id
            if (helperId) {
                try {
                    await client.session.delete({ path: { id: helperId } })
                } catch (err: any) {
                    logger.warn("Failed to delete DCP helper session", { error: err.message })
                }
                const internalSessionIdsModule = await import("../state")
                internalSessionIdsModule.INTERNAL_SESSION_IDS.delete(helperId)
            }
        }
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    ctx.state.manualMode = ctx.state.manualMode ? "active" : false
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}
