// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { formatTokenCount } from "../../lib/ui/utils"
import { loadContextSnapshotCached, peekContextSnapshot } from "../data/context"
import { openPanel } from "../shared/navigation"
import { getPalette, type DcpPalette } from "../shared/theme"
import type { DcpRouteNames, DcpTuiClient, DcpTuiConfig } from "../shared/types"

const BAR_WIDTH = 12

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
    const percent = props.total > 0 ? `${Math.round((props.value / props.total) * 100)}%` : "0%"
    const label = props.label.padEnd(8, " ")
    const bar = buildBar(props.value, props.total, props.char)
    return (
        <text
            fg={toneColor(props.palette, props.tone)}
        >{`${label} ${percent.padStart(4, " ")} |${bar}| ${compactTokenCount(props.value)}`}</text>
    )
}

const SidebarContext = (props: {
    api: any
    client: DcpTuiClient
    config: DcpTuiConfig
    names: DcpRouteNames
    palette: DcpPalette
    sessionID: string
}) => {
    const [snapshot, setSnapshot] = createSignal(peekContextSnapshot(props.sessionID))
    const [loading, setLoading] = createSignal(!snapshot())
    const [error, setError] = createSignal<string>()

    createEffect(() => {
        const sessionID = props.sessionID
        const cached = peekContextSnapshot(sessionID)
        setSnapshot(cached)
        setLoading(!cached)
        setError(undefined)

        let active = true
        void loadContextSnapshotCached(props.client, sessionID)
            .then((value) => {
                if (!active) return
                setSnapshot(value)
                setLoading(false)
            })
            .catch((cause) => {
                if (!active) return
                setError(cause instanceof Error ? cause.message : String(cause))
                setLoading(false)
            })

        onCleanup(() => {
            active = false
        })
    })

    const prunedItems = createMemo(() => {
        const value = snapshot()
        if (!value) return "No pruned items"
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
        const value = snapshot()
        if (!value) return "0"
        return `${value.persisted.activeBlockCount}`
    })

    const topicLine = createMemo(() => {
        const value = snapshot()
        if (!value) return ""
        if (!value.persisted.activeBlockTopics.length) return ""
        return `Topics: ${value.persisted.activeBlockTopics.join(" | ")}`
    })

    const status = createMemo(() => {
        if (error() && snapshot()) return { label: "cached", tone: "warning" as const }
        if (error()) return { label: "error", tone: "warning" as const }
        if (loading() && snapshot()) return { label: "refreshing", tone: "warning" as const }
        if (loading()) return { label: "loading", tone: "warning" as const }
        return { label: "loaded", tone: "success" as const }
    })

    return (
        <box
            width="100%"
            flexDirection="column"
            gap={0}
            backgroundColor={props.palette.base}
            border={["left"]}
            borderColor={props.palette.accent}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => openPanel(props.api, props.names, "sidebar", props.sessionID)}
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
                <text fg={props.palette.muted}>session {props.sessionID.slice(0, 18)}</text>
            </box>

            <Show when={loading() && !snapshot()}>
                <box paddingTop={1}>
                    <text fg={props.palette.muted}>Loading DCP context...</text>
                </box>
            </Show>

            <Show when={error() && !snapshot()}>
                <box paddingTop={1}>
                    <text fg={props.palette.warning}>DCP context failed to load.</text>
                </box>
            </Show>

            <Show when={snapshot()}>
                {(value) => (
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
                                <b>~{compactTokenCount(value().breakdown.total)}</b>
                            </text>
                        </box>
                        <SummaryRow
                            palette={props.palette}
                            label="Saved"
                            value={`~${compactTokenCount(value().breakdown.prunedTokens)}`}
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
                                value={value().breakdown.system}
                                total={value().breakdown.total}
                                char="█"
                                tone="accent"
                            />
                            <SidebarContextBar
                                palette={props.palette}
                                label="User"
                                value={value().breakdown.user}
                                total={value().breakdown.total}
                                char="▓"
                                tone="text"
                            />
                            <SidebarContextBar
                                palette={props.palette}
                                label="Assist"
                                value={value().breakdown.assistant}
                                total={value().breakdown.total}
                                char="▒"
                                tone="muted"
                            />
                            <SidebarContextBar
                                palette={props.palette}
                                label="Tools"
                                value={value().breakdown.tools}
                                total={value().breakdown.total}
                                char="░"
                                tone="warning"
                            />
                        </box>

                        <box width="100%" flexDirection="column" gap={0} paddingTop={1}>
                            <text fg={props.palette.muted}>{prunedItems()}</text>
                            <Show when={topicLine()}>
                                <text fg={props.palette.muted}>{topicLine()}</text>
                            </Show>
                            <Show when={value().notes[0] && !topicLine()}>
                                <text fg={props.palette.muted}>{value().notes[0]}</text>
                            </Show>
                        </box>
                    </box>
                )}
            </Show>
        </box>
    )
}

export const createSidebarTopSlot = (
    api: any,
    client: DcpTuiClient,
    config: DcpTuiConfig,
    names: DcpRouteNames,
) => ({
    id: names.slot,
    slots: {
        sidebar_top(ctx, value: { session_id: string }) {
            const palette = getPalette(ctx.theme.current as Record<string, unknown>)
            return (
                <SidebarContext
                    api={api}
                    client={client}
                    config={config}
                    names={names}
                    palette={palette}
                    sessionID={value.session_id}
                />
            )
        },
    },
})
