/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { TuiApi, TuiPluginInput } from "@opencode-ai/plugin/tui"
import { Logger } from "../../lib/logger"
import { formatTokenCount } from "../../lib/ui/utils"
import {
    createPlaceholderContextSnapshot,
    invalidateContextSnapshot,
    loadContextSnapshotCached,
    peekContextSnapshot,
} from "../data/context"
import { openPanel } from "../shared/navigation"
import { getPalette, type DcpPalette } from "../shared/theme"
import type { DcpRouteNames, DcpTuiClient, DcpTuiConfig } from "../shared/types"

const BAR_WIDTH = 12
const REFRESH_DEBOUNCE_MS = 100

const toneColor = (
    palette: DcpPalette,
    tone: "text" | "muted" | "accent" | "success" | "warning" = "text",
) => {
    if (tone === "accent") return palette.accent
    if (tone === "success") return palette.success
    if (tone === "warning") return palette.warning
    if (tone === "muted") return palette.muted
    return palette.text
}

const compactTokenCount = (value: number) => formatTokenCount(value).replace(/ tokens$/, "")

const buildBar = (value: number, total: number, char: string) => {
    if (total <= 0) return " ".repeat(BAR_WIDTH)
    const filled = Math.max(0, Math.round((value / total) * BAR_WIDTH))
    return char.repeat(filled).padEnd(BAR_WIDTH, " ")
}

const SummaryRow = (props: {
    palette: DcpPalette
    label: string
    value: string
    tone?: "text" | "muted" | "accent" | "success" | "warning"
}) => {
    return (
        <box
            width="100%"
            backgroundColor={props.palette.surface}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="row"
            justifyContent="space-between"
        >
            <text fg={props.palette.muted}>{props.label}</text>
            <text fg={toneColor(props.palette, props.tone)}>
                <b>{props.value}</b>
            </text>
        </box>
    )
}

const SidebarContextBar = (props: {
    palette: DcpPalette
    label: string
    value: number
    total: number
    char: string
    tone?: "text" | "muted" | "accent" | "success" | "warning"
}) => {
    const percent = createMemo(() =>
        props.total > 0 ? `${Math.round((props.value / props.total) * 100)}%` : "0%",
    )
    const label = createMemo(() => props.label.padEnd(8, " "))
    const bar = createMemo(() => buildBar(props.value, props.total, props.char))
    return (
        <text
            fg={toneColor(props.palette, props.tone)}
        >{`${label()} ${percent().padStart(4, " ")} |${bar()}| ${compactTokenCount(props.value)}`}</text>
    )
}

const SidebarContext = (props: {
    api: TuiApi
    client: DcpTuiClient
    event: TuiPluginInput["event"]
    renderer: TuiPluginInput["renderer"]
    logger: Logger
    config: DcpTuiConfig
    names: DcpRouteNames
    palette: DcpPalette
    sessionID: () => string
}) => {
    const initialSnapshot = peekContextSnapshot(props.sessionID())
    const [snapshot, setSnapshot] = createSignal(
        initialSnapshot ?? createPlaceholderContextSnapshot(props.sessionID()),
    )
    const [loading, setLoading] = createSignal(!initialSnapshot)
    const [error, setError] = createSignal<string>()
    let requestVersion = 0
    let renderTimeout: ReturnType<typeof setTimeout> | undefined

    const requestRender = (reason: string, data?: Record<string, unknown>) => {
        const activeSessionID = untrack(() => props.sessionID())
        void props.logger.debug("Sidebar requested renderer refresh", {
            activeSessionID,
            reason,
            ...data,
        })
        if (renderTimeout) clearTimeout(renderTimeout)
        renderTimeout = setTimeout(() => {
            renderTimeout = undefined
            try {
                void props.logger.debug("Sidebar renderer refresh dispatched", {
                    activeSessionID,
                    reason,
                    ...data,
                })
                props.renderer.requestRender()
            } catch (cause) {
                void props.logger.warn("Sidebar renderer refresh failed", {
                    activeSessionID,
                    reason,
                    error: cause instanceof Error ? cause.message : String(cause),
                    ...data,
                })
            }
        }, 0)
    }

    onCleanup(() => {
        if (renderTimeout) clearTimeout(renderTimeout)
    })

    const refreshSnapshot = async (
        sessionID: string,
        options?: { invalidate?: boolean; preserveSnapshot?: boolean; reason?: string },
    ) => {
        const preserveSnapshot = options?.preserveSnapshot ?? false
        const reason = options?.reason ?? "unspecified"

        void props.logger.debug("Sidebar refresh start", {
            sessionID,
            invalidate: !!options?.invalidate,
            preserveSnapshot,
            reason,
        })

        if (options?.invalidate) {
            invalidateContextSnapshot(sessionID)
        }

        const cached = peekContextSnapshot(sessionID)
        if (cached) {
            void props.logger.debug("Sidebar using cached snapshot before reload", {
                sessionID,
                loadedAt: cached.loadedAt,
                totalTokens: cached.breakdown.total,
            })
            setSnapshot(cached)
            setLoading(false)
        } else {
            const current = untrack(snapshot)
            if (!preserveSnapshot || current?.sessionID !== sessionID) {
                setSnapshot(createPlaceholderContextSnapshot(sessionID, ["Loading DCP context..."]))
            }
            setLoading(true)
            void props.logger.debug("Sidebar entering loading state", {
                sessionID,
                hadCurrentSnapshot: !!current,
                preservedSnapshot: preserveSnapshot && current?.sessionID === sessionID,
            })
        }
        setError(undefined)
        requestRender("refresh-start", { sessionID, reason })

        const currentRequest = ++requestVersion
        void props.logger.debug("Sidebar refresh request issued", {
            sessionID,
            requestVersion: currentRequest,
            reason,
        })

        try {
            const value = await loadContextSnapshotCached(props.client, sessionID)
            if (currentRequest !== requestVersion || props.sessionID() !== sessionID) {
                void props.logger.debug("Sidebar refresh result ignored as stale", {
                    sessionID,
                    requestVersion: currentRequest,
                    activeRequestVersion: requestVersion,
                    activeSessionID: props.sessionID(),
                    reason,
                })
                return
            }
            setSnapshot(value)
            setLoading(false)
            void props.logger.debug("Sidebar refresh succeeded", {
                sessionID,
                requestVersion: currentRequest,
                totalTokens: value.breakdown.total,
                messageCount: value.breakdown.messageCount,
                activeBlockCount: value.persisted.activeBlockCount,
                reason,
            })
            requestRender("refresh-success", { sessionID, reason, requestVersion: currentRequest })
        } catch (cause) {
            if (currentRequest !== requestVersion || props.sessionID() !== sessionID) {
                void props.logger.debug("Sidebar refresh error ignored as stale", {
                    sessionID,
                    requestVersion: currentRequest,
                    activeRequestVersion: requestVersion,
                    activeSessionID: props.sessionID(),
                    reason,
                })
                return
            }
            setError(cause instanceof Error ? cause.message : String(cause))
            setLoading(false)
            void props.logger.error("Sidebar refresh failed", {
                sessionID,
                requestVersion: currentRequest,
                error: cause instanceof Error ? cause.message : String(cause),
                reason,
            })
            requestRender("refresh-error", { sessionID, reason, requestVersion: currentRequest })
        }
    }

    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                void props.logger.info("Sidebar active session changed", { sessionID })
                void refreshSnapshot(sessionID, { reason: "session-change" })
            },
            { defer: false },
        ),
    )

    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                let timeout: ReturnType<typeof setTimeout> | undefined
                let pendingReason: string | undefined

                void props.logger.debug("Sidebar event subscriptions armed", { sessionID })

                const scheduleRefresh = (reason: string, data?: Record<string, unknown>) => {
                    if (!sessionID) return
                    if (timeout) clearTimeout(timeout)
                    pendingReason = reason
                    void props.logger.debug("Sidebar refresh scheduled", {
                        sessionID,
                        debounceMs: REFRESH_DEBOUNCE_MS,
                        reason,
                        ...data,
                    })
                    timeout = setTimeout(() => {
                        const flushReason = pendingReason ?? reason
                        pendingReason = undefined
                        timeout = undefined
                        void props.logger.debug("Sidebar refresh debounce fired", {
                            sessionID,
                            reason: flushReason,
                        })
                        void refreshSnapshot(sessionID, {
                            invalidate: true,
                            preserveSnapshot: true,
                            reason: flushReason,
                        })
                    }, REFRESH_DEBOUNCE_MS)
                }

                const unsubs = [
                    props.event.on("message.updated", (event) => {
                        if (event.properties.info.sessionID !== sessionID) return
                        scheduleRefresh("message.updated", {
                            eventSessionID: event.properties.info.sessionID,
                            messageID: event.properties.info.id,
                        })
                    }),
                    props.event.on("message.removed", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh("message.removed", {
                            eventSessionID: event.properties.sessionID,
                            messageID: event.properties.messageID,
                        })
                    }),
                    props.event.on("message.part.updated", (event) => {
                        if (event.properties.part.sessionID !== sessionID) return
                        scheduleRefresh("message.part.updated", {
                            eventSessionID: event.properties.part.sessionID,
                            messageID: event.properties.part.messageID,
                            partID: event.properties.part.id,
                        })
                    }),
                    props.event.on("message.part.delta", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh("message.part.delta", {
                            eventSessionID: event.properties.sessionID,
                            messageID: event.properties.messageID,
                            partID: event.properties.partID,
                            field: event.properties.field,
                        })
                    }),
                    props.event.on("message.part.removed", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh("message.part.removed", {
                            eventSessionID: event.properties.sessionID,
                            messageID: event.properties.messageID,
                            partID: event.properties.partID,
                        })
                    }),
                    props.event.on("session.updated", (event) => {
                        if (event.properties.info.id !== sessionID) return
                        scheduleRefresh("session.updated", {
                            eventSessionID: event.properties.info.id,
                        })
                    }),
                    props.event.on("session.deleted", (event) => {
                        if (event.properties.info.id !== sessionID) return
                        scheduleRefresh("session.deleted", {
                            eventSessionID: event.properties.info.id,
                        })
                    }),
                    props.event.on("session.diff", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh("session.diff", {
                            eventSessionID: event.properties.sessionID,
                        })
                    }),
                    props.event.on("session.error", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh("session.error", {
                            eventSessionID: event.properties.sessionID,
                            error: event.properties.error,
                        })
                    }),
                    props.event.on("session.status", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh("session.status", {
                            eventSessionID: event.properties.sessionID,
                            status: event.properties.status,
                        })
                    }),
                ]

                onCleanup(() => {
                    if (timeout) clearTimeout(timeout)
                    void props.logger.debug("Sidebar event subscriptions cleaned up", { sessionID })
                    for (const unsub of unsubs) {
                        unsub()
                    }
                })
            },
            { defer: false },
        ),
    )

    const prunedItems = createMemo(() => {
        const value = snapshot()
        const parts: string[] = []
        if (value.breakdown.prunedToolCount > 0) {
            parts.push(
                `${value.breakdown.prunedToolCount} tool${value.breakdown.prunedToolCount === 1 ? "" : "s"}`,
            )
        }
        if (value.breakdown.prunedMessageCount > 0) {
            parts.push(
                `${value.breakdown.prunedMessageCount} msg${value.breakdown.prunedMessageCount === 1 ? "" : "s"}`,
            )
        }
        return parts.length > 0 ? `${parts.join(", ")} pruned` : "No pruned items"
    })

    const blockSummary = createMemo(() => {
        return `${snapshot().persisted.activeBlockCount}`
    })

    const topicLine = createMemo(() => {
        const value = snapshot()
        if (!value.persisted.activeBlockTopics.length) return ""
        return `Topics: ${value.persisted.activeBlockTopics.join(" | ")}`
    })

    const noteLine = createMemo(() => {
        const topic = topicLine()
        if (topic) return topic
        return snapshot().notes[0] ?? ""
    })

    const stateLine = createMemo(() => {
        if (error() && snapshot().breakdown.total === 0) return "DCP context failed to load."
        if (error()) return `Refresh failed: ${error()}`
        if (loading()) return "Loading DCP context..."
        return "DCP context loaded."
    })

    const status = createMemo(() => {
        if (error() && snapshot().breakdown.total > 0)
            return { label: "cached", tone: "warning" as const }
        if (error()) return { label: "error", tone: "warning" as const }
        if (loading() && snapshot().breakdown.total > 0)
            return { label: "refreshing", tone: "warning" as const }
        if (loading()) return { label: "loading", tone: "warning" as const }
        return { label: "loaded", tone: "success" as const }
    })

    return (
        <box
            width="100%"
            flexDirection="column"
            gap={0}
            backgroundColor={props.palette.base}
            border={{ type: "single" }}
            borderColor={props.palette.accent}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => openPanel(props.api, props.names, "sidebar", props.sessionID())}
        >
            <box flexDirection="row" justifyContent="space-between" alignItems="center">
                <box flexDirection="row" gap={1} alignItems="center">
                    <box paddingLeft={1} paddingRight={1} backgroundColor={props.palette.accent}>
                        <text fg={props.palette.panel}>
                            <b>{props.config.label}</b>
                        </text>
                    </box>
                    <text fg={props.palette.muted}>click for more</text>
                </box>
                <text fg={toneColor(props.palette, status().tone)}>{status().label}</text>
            </box>

            <box flexDirection="row" justifyContent="space-between">
                <text fg={props.palette.muted}>session {props.sessionID().slice(0, 18)}</text>
            </box>

            <box paddingTop={1}>
                <text fg={error() ? props.palette.warning : props.palette.muted}>
                    {stateLine()}
                </text>
            </box>

            <box width="100%" flexDirection="column" gap={0} paddingTop={1}>
                <box
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={props.palette.surface}
                    paddingLeft={1}
                    paddingRight={1}
                >
                    <text fg={props.palette.muted}>Current</text>
                    <text fg={props.palette.accent}>
                        <b>~{compactTokenCount(snapshot().breakdown.total)}</b>
                    </text>
                </box>
                <SummaryRow
                    palette={props.palette}
                    label="Saved"
                    value={`~${compactTokenCount(snapshot().breakdown.prunedTokens)}`}
                    tone="success"
                />
                <SummaryRow
                    palette={props.palette}
                    label="Compressions"
                    value={blockSummary()}
                    tone="accent"
                />

                <box width="100%" flexDirection="column" gap={0} paddingTop={1}>
                    <SidebarContextBar
                        palette={props.palette}
                        label="System"
                        value={snapshot().breakdown.system}
                        total={snapshot().breakdown.total}
                        char="█"
                        tone="accent"
                    />
                    <SidebarContextBar
                        palette={props.palette}
                        label="User"
                        value={snapshot().breakdown.user}
                        total={snapshot().breakdown.total}
                        char="▓"
                        tone="text"
                    />
                    <SidebarContextBar
                        palette={props.palette}
                        label="Assist"
                        value={snapshot().breakdown.assistant}
                        total={snapshot().breakdown.total}
                        char="▒"
                        tone="muted"
                    />
                    <SidebarContextBar
                        palette={props.palette}
                        label="Tools"
                        value={snapshot().breakdown.tools}
                        total={snapshot().breakdown.total}
                        char="░"
                        tone="warning"
                    />
                </box>

                <box width="100%" flexDirection="column" gap={0} paddingTop={1}>
                    <text fg={props.palette.muted}>{prunedItems()}</text>
                    <text fg={props.palette.muted}>{noteLine()}</text>
                </box>
            </box>
        </box>
    )
}

export const createSidebarTopSlot = (
    api: TuiApi,
    client: DcpTuiClient,
    event: TuiPluginInput["event"],
    renderer: TuiPluginInput["renderer"],
    logger: Logger,
    config: DcpTuiConfig,
    names: DcpRouteNames,
) => ({
    id: names.slot,
    slots: {
        sidebar_top(ctx, value: { session_id: string }) {
            // value is a reactive proxy from @opentui/solid splitProps —
            // value.session_id updates automatically when the host navigates
            // to a different session (no event subscription needed).
            const palette = createMemo(() =>
                getPalette(ctx.theme.current as Record<string, unknown>),
            )
            return (
                <SidebarContext
                    api={api}
                    client={client}
                    event={event}
                    renderer={renderer}
                    logger={logger}
                    config={config}
                    names={names}
                    palette={palette()}
                    sessionID={() => value.session_id}
                />
            )
        },
    },
})
