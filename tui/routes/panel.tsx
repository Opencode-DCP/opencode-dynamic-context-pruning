// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid"
import type { TuiApi, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { MetricRow } from "../components/metric-row"
import { Screen } from "../components/screen"
import { Section } from "../components/section"
import { getRouteSource, getSessionIDFromParams, goBack } from "../shared/navigation"
import { getPalette } from "../shared/theme"
import type { DcpRouteNames, DcpTuiConfig } from "../shared/types"

const PanelScreen = (props: {
    api: TuiApi
    config: DcpTuiConfig
    names: DcpRouteNames
    params?: Record<string, unknown>
}) => {
    const palette = getPalette(props.api.theme.current as Record<string, unknown>)
    const sessionID = () => getSessionIDFromParams(props.params)
    const source = () => getRouteSource(props.params)

    useKeyboard((evt) => {
        if (props.api.route.current.name !== props.names.routes.panel) return
        if (evt.name !== "escape" && !(evt.ctrl && evt.name === "h")) return
        evt.preventDefault()
        evt.stopPropagation()
        goBack(props.api, sessionID())
    })

    return (
        <Screen
            palette={palette}
            title={props.config.label}
            subtitle="Placeholder shell for future DCP tools and views."
            footer="Press Esc to return"
        >
            <Section palette={palette} title="What lives here later">
                <text fg={palette.muted}>
                    Use this page as the home for future DCP-specific TUI work.
                </text>
                <text fg={palette.muted}>
                    The live context breakdown now lives directly in the session sidebar.
                </text>
            </Section>

            <Section palette={palette} title="Session">
                <MetricRow palette={palette} label="Opened from" value={source()} />
                <MetricRow palette={palette} label="Session" value={sessionID() || "none"} />
                <MetricRow
                    palette={palette}
                    label="Route"
                    value={props.names.routes.panel}
                    tone="muted"
                />
            </Section>

            <Section palette={palette} title="Future ideas">
                <text fg={palette.muted}>- block explorer</text>
                <text fg={palette.muted}>- prune history and diagnostics</text>
                <text fg={palette.muted}>- manual DCP actions</text>
            </Section>
        </Screen>
    )
}

export const createPanelRoute = (input: {
    api: TuiApi
    config: DcpTuiConfig
    names: DcpRouteNames
}): TuiRouteDefinition => {
    return {
        name: input.names.routes.panel,
        render: ({ params }) => (
            <PanelScreen
                api={input.api}
                config={input.config}
                names={input.names}
                params={params}
            />
        ),
    }
}
