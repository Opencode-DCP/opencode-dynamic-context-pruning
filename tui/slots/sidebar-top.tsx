/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { TuiApi, TuiPluginInput } from "@opencode-ai/plugin/tui"
import { Logger } from "../../lib/logger"
import { truncate } from "../../lib/ui/utils"
import {
    createPlaceholderContextSnapshot,
    invalidateContextSnapshot,
    loadContextSnapshotCached,
    peekContextSnapshot,
} from "../data/context"
import { openPanel } from "../shared/navigation"
import { getPalette, toneColor, type DcpColor, type DcpPalette } from "../shared/theme"
import { LABEL, type DcpRouteNames } from "../shared/names"
import type { DcpMessageStatus, DcpTuiClient } from "../shared/types"

const BAR_WIDTH = 12
const SINGLE_BORDER = { type: "single" } as any
const DIM_TEXT = { dim: true } as any
// Content width derived from graph row: label(9) + space(1) + percent(4) + " |"(2) + bar(12) + "| "(2) + tokens(~5)
const CONTENT_WIDTH = 9 + 1 + 4 + 2 + BAR_WIDTH + 2 + 5

const REFRESH_DEBOUNCE_MS = 100

const compactTokenCount = (value: number): string => {
    if (value >= 1_000_000) {
        const m = (value / 1_000_000).toFixed(2)
        return `${m}M`
    }
    if (value >= 100_000) return `${Math.round(value / 1000)}K`
    if (value >= 1_000) {
        const k = (value / 1000).toFixed(1)
        return k.endsWith(".0") ? `${Math.round(value / 1000)}K` : `${k}K`
    }
    const d = Math.round(value / 100)
    if (d >= 10) return `${Math.round(value / 1000)}K`
    if (d > 0) return `.${d}K`
    return "0"
}

const buildBar = (value: number, total: number) => {
    if (total <= 0) return " ".repeat(BAR_WIDTH)
    const filled = Math.max(0, Math.round((value / total) * BAR_WIDTH))
    return "█".repeat(filled).padEnd(BAR_WIDTH, " ")
}

const buildMessageBar = (
    statuses: DcpMessageStatus[],
    width: number = CONTENT_WIDTH,
): { text: string; status: DcpMessageStatus }[] => {
    const ACTIVE = "█"
    const PRUNED = "░"
    if (statuses.length === 0) return [{ text: PRUNED.repeat(width), status: "pruned" }]

    // Map each bar position to a message status
    const bar: DcpMessageStatus[] = new Array(width).fill("active")
    for (let m = 0; m < statuses.length; m++) {
        const start = Math.floor((m / statuses.length) * width)
        const end = Math.floor(((m + 1) / statuses.length) * width)
        for (let i = start; i < end; i++) {
            bar[i] = statuses[m]
        }
    }

    // Group consecutive same-status positions into runs
    const runs: { text: string; status: DcpMessageStatus }[] = []
    let runStart = 0
    for (let i = 1; i <= width; i++) {
        if (i === width || bar[i] !== bar[runStart]) {
            const char = bar[runStart] === "pruned" ? PRUNED : ACTIVE
            runs.push({ text: char.repeat(i - runStart), status: bar[runStart] })
            runStart = i
        }
    }
    return runs
}

const SummaryRow = (props: {
    palette: DcpPalette
    label: string
    value: string
    tone?: "text" | "muted" | "accent" | "success" | "warning"
    swatch?: DcpColor
    marginTop?: number
}) => {
    return (
        <box
            width="100%"
            flexDirection="row"
            justifyContent="space-between"
            marginTop={props.marginTop}
        >
            <box flexDirection="row">
                {props.swatch && <text fg={props.swatch}>{"█ "}</text>}
                <text fg={props.palette.text}>{props.label}</text>
            </box>
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
    tone?: "text" | "muted" | "accent" | "success" | "warning"
}) => {
    const percent = createMemo(() =>
        props.total > 0 ? `${Math.round((props.value / props.total) * 100)}%` : "0%",
    )
    const label = createMemo(() => props.label.padEnd(9, " "))
    const bar = createMemo(() => buildBar(props.value, props.total))
    return (
        <box flexDirection="row">
            <text fg={props.palette.text}>
                {label()}
                {` ${percent().padStart(4, " ")} |`}
            </text>
            <text fg={toneColor(props.palette, props.tone)}>{bar()}</text>
            <text
                fg={props.palette.text}
            >{`| ${compactTokenCount(props.value).padStart(5, " ")}`}</text>
        </box>
    )
}

const SidebarContext = (props: {
    api: TuiApi
    client: DcpTuiClient
    event: TuiPluginInput["event"]
    renderer: TuiPluginInput["renderer"]
    names: DcpRouteNames
    palette: DcpPalette
    sessionID: () => string
    logger: Logger
}) => {
    const initialSnapshot = peekContextSnapshot(props.sessionID())
    const [snapshot, setSnapshot] = createSignal(
        initialSnapshot ?? createPlaceholderContextSnapshot(props.sessionID()),
    )
    const [loading, setLoading] = createSignal(!initialSnapshot)
    const [error, setError] = createSignal<string>()
    let requestVersion = 0
    let renderTimeout: ReturnType<typeof setTimeout> | undefined

    const requestRender = () => {
        if (renderTimeout) clearTimeout(renderTimeout)
        renderTimeout = setTimeout(() => {
            renderTimeout = undefined
            try {
                props.renderer.requestRender()
            } catch (error) {
                props.logger.warn("Failed to request TUI render", {
                    error: error instanceof Error ? error.message : String(error),
                })
            }
        }, 0)
    }

    onCleanup(() => {
        if (renderTimeout) clearTimeout(renderTimeout)
    })

    const refreshSnapshot = async (
        sessionID: string,
        options?: { invalidate?: boolean; preserveSnapshot?: boolean },
    ) => {
        if (options?.invalidate) {
            invalidateContextSnapshot(sessionID)
        }

        const cached = peekContextSnapshot(sessionID)
        let silentRefresh = false
        if (cached) {
            setSnapshot(cached)
            setLoading(false)
        } else {
            const current = untrack(snapshot)
            if (options?.preserveSnapshot && current?.sessionID === sessionID) {
                silentRefresh = true
            } else {
                setSnapshot(createPlaceholderContextSnapshot(sessionID, ["Loading DCP context..."]))
                setLoading(true)
            }
        }
        setError(undefined)
        if (!silentRefresh) {
            requestRender()
        }

        const currentRequest = ++requestVersion

        try {
            const value = await loadContextSnapshotCached(props.client, props.logger, sessionID)
            if (currentRequest !== requestVersion || props.sessionID() !== sessionID) {
                return
            }
            setSnapshot(value)
            setLoading(false)
            requestRender()
        } catch (cause) {
            if (currentRequest !== requestVersion || props.sessionID() !== sessionID) {
                return
            }
            props.logger.warn("Failed to refresh sidebar snapshot", {
                sessionID,
                error: cause instanceof Error ? cause.message : String(cause),
            })
            setError(cause instanceof Error ? cause.message : String(cause))
            setLoading(false)
            requestRender()
        }
    }

    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                void refreshSnapshot(sessionID)
            },
            { defer: false },
        ),
    )

    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                let timeout: ReturnType<typeof setTimeout> | undefined

                const scheduleRefresh = () => {
                    if (!sessionID) return
                    if (timeout) clearTimeout(timeout)
                    timeout = setTimeout(() => {
                        timeout = undefined
                        void refreshSnapshot(sessionID, {
                            invalidate: true,
                            preserveSnapshot: true,
                        })
                    }, REFRESH_DEBOUNCE_MS)
                }

                const unsubs = [
                    props.event.on("message.updated", (event) => {
                        if (event.properties.info.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("message.removed", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("message.part.updated", (event) => {
                        if (event.properties.part.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("message.part.delta", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("message.part.removed", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("session.updated", (event) => {
                        if (event.properties.info.id !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("session.deleted", (event) => {
                        if (event.properties.info.id !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("session.diff", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("session.error", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.event.on("session.status", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                ]

                onCleanup(() => {
                    if (timeout) clearTimeout(timeout)
                    for (const unsub of unsubs) {
                        unsub()
                    }
                })
            },
            { defer: false },
        ),
    )

    const topics = createMemo(() => snapshot().persisted.activeBlockTopics)
    const topicTotal = createMemo(() => snapshot().persisted.activeBlockTopicTotal)
    const topicOverflow = createMemo(() => topicTotal() - topics().length)
    const fallbackNote = createMemo(() => snapshot().notes[0] ?? "")

    const messageBarRuns = createMemo(() => buildMessageBar(snapshot().messageStatuses))

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
            backgroundColor={props.palette.surface}
            border={SINGLE_BORDER}
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
                            <b>{LABEL}</b>
                        </text>
                    </box>
                    <text fg={props.palette.text}>click for more</text>
                </box>
                <text fg={toneColor(props.palette, status().tone)}>{status().label}</text>
            </box>

            <SummaryRow
                palette={props.palette}
                label="Saved Tokens"
                value={`~${compactTokenCount(snapshot().breakdown.prunedTokens)}`}
                tone="accent"
                swatch={props.palette.muted}
                marginTop={1}
            />
            <SummaryRow
                palette={props.palette}
                label="Current Context"
                value={`~${compactTokenCount(snapshot().breakdown.total)}`}
                tone="accent"
                swatch={props.palette.accent}
            />

            {snapshot().messageStatuses.length > 0 && (
                <box flexDirection="row" marginTop={1}>
                    {messageBarRuns().map((run) => (
                        <text
                            fg={
                                run.status === "active" ? props.palette.accent : props.palette.muted
                            }
                        >
                            {run.text}
                        </text>
                    ))}
                </box>
            )}

            <box width="100%" flexDirection="column" paddingTop={1}>
                <SidebarContextBar
                    palette={props.palette}
                    label="System"
                    value={snapshot().breakdown.system}
                    total={snapshot().breakdown.total}
                    tone="accent"
                />
                <SidebarContextBar
                    palette={props.palette}
                    label="User"
                    value={snapshot().breakdown.user}
                    total={snapshot().breakdown.total}
                    tone="accent"
                />
                <SidebarContextBar
                    palette={props.palette}
                    label="Assistant"
                    value={snapshot().breakdown.assistant}
                    total={snapshot().breakdown.total}
                    tone="accent"
                />
                <SidebarContextBar
                    palette={props.palette}
                    label="Tools"
                    value={snapshot().breakdown.tools}
                    total={snapshot().breakdown.total}
                    tone="accent"
                />
            </box>

            <box width="100%" flexDirection="column" gap={0} paddingTop={1}>
                {topics().length > 0 ? (
                    <>
                        <text fg={props.palette.text}>
                            <b>Compressed Topics</b>
                        </text>
                        {topics().map((t) => (
                            <text fg={props.palette.muted}>{truncate(t, CONTENT_WIDTH)}</text>
                        ))}
                        {topicOverflow() > 0 ? (
                            <text {...DIM_TEXT} fg={props.palette.muted}>
                                ... {topicOverflow()} more topics
                            </text>
                        ) : null}
                    </>
                ) : fallbackNote() ? (
                    <text fg={props.palette.muted}>{fallbackNote()}</text>
                ) : null}
            </box>

            {snapshot().allTimeStats.sessionCount > 0 && (
                <box width="100%" flexDirection="column" paddingTop={1}>
                    <text fg={props.palette.text}>
                        <b>All Time</b>
                    </text>
                    <SummaryRow
                        palette={props.palette}
                        label="Tokens Saved"
                        value={`~${compactTokenCount(snapshot().allTimeStats.totalTokensSaved)}`}
                        tone="accent"
                    />
                    <SummaryRow
                        palette={props.palette}
                        label="Sessions"
                        value={`${snapshot().allTimeStats.sessionCount}`}
                        tone="accent"
                    />
                </box>
            )}
        </box>
    )
}

export const createSidebarTopSlot = (
    api: TuiApi,
    client: DcpTuiClient,
    event: TuiPluginInput["event"],
    renderer: TuiPluginInput["renderer"],
    names: DcpRouteNames,
    logger: Logger,
) => ({
    id: names.slot,
    slots: {
        sidebar_top(
            ctx: { theme: { current: Record<string, unknown> } },
            value: { session_id: string },
        ) {
            const palette = createMemo(() =>
                getPalette(ctx.theme.current as Record<string, unknown>),
            )
            return (
                <SidebarContext
                    api={api}
                    client={client}
                    event={event}
                    renderer={renderer}
                    names={names}
                    palette={palette()}
                    sessionID={() => value.session_id}
                    logger={logger}
                />
            )
        },
    },
})
