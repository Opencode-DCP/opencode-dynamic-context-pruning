/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiApi } from "@opencode-ai/plugin/tui"
import { getPalette, type DcpPalette } from "../shared/theme"
import { LABEL, NAMES } from "../shared/names"

const SINGLE_BORDER = { type: "single" } as any

interface SummaryRouteParams {
    topic?: string
    summary?: string
    sessionID?: string
}

interface CollapsibleSection {
    label: string
    content: string
}

interface ParsedSummary {
    body: string
    sections: CollapsibleSection[]
}

const SECTION_HEADINGS: { pattern: RegExp; label: string }[] = [
    {
        pattern: /\n*The following user messages were sent in this conversation verbatim:/,
        label: "Protected User Messages",
    },
    {
        pattern: /\n*The following protected tools were used in this conversation as well:/,
        label: "Protected Tools",
    },
    {
        pattern:
            /\n*The following previously compressed summaries were also part of this conversation section:/,
        label: "Included Compressed Summaries",
    },
]

function parseSummary(raw: string): ParsedSummary {
    if (!raw) return { body: "", sections: [] }

    const matches: { index: number; length: number; label: string }[] = []
    for (const heading of SECTION_HEADINGS) {
        const match = raw.match(heading.pattern)
        if (match && match.index !== undefined) {
            matches.push({ index: match.index, length: match[0].length, label: heading.label })
        }
    }

    if (matches.length === 0) {
        return { body: raw, sections: [] }
    }

    matches.sort((a, b) => a.index - b.index)

    const body = raw.slice(0, matches[0].index).trimEnd()
    const sections: CollapsibleSection[] = []

    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index + matches[i].length
        const end = i + 1 < matches.length ? matches[i + 1].index : raw.length
        const content = raw.slice(start, end).trim()
        if (content) {
            sections.push({ label: matches[i].label, content })
        }
    }

    return { body, sections }
}

function CollapsibleSectionRow(props: { section: CollapsibleSection; palette: DcpPalette }) {
    const [expanded, setExpanded] = createSignal(false)

    return (
        <box flexDirection="column" width="100%" marginTop={1}>
            <box flexDirection="row" width="100%" height={1}>
                <box
                    backgroundColor={props.palette.base}
                    height={1}
                    onMouseUp={() => setExpanded(!expanded())}
                >
                    <text fg={props.palette.accent}>{expanded() ? " ▼ " : " ▶ "}</text>
                </box>
                <box height={1} paddingLeft={1}>
                    <text fg={props.palette.muted} onMouseUp={() => setExpanded(!expanded())}>
                        {props.section.label}
                    </text>
                </box>
            </box>
            <Show when={expanded()}>
                <box width="100%" marginTop={1} paddingLeft={2} flexDirection="column">
                    <text fg={props.palette.text}>{props.section.content}</text>
                </box>
            </Show>
        </box>
    )
}

function SummaryScreen(props: { api: TuiApi }) {
    const params = createMemo(() => (props.api.route.current.params ?? {}) as SummaryRouteParams)
    const palette = createMemo(() => getPalette(props.api.theme.current as Record<string, unknown>))
    const parsed = createMemo(() => parseSummary(params().summary || ""))

    const keys = props.api.keybind?.create({ close: "escape" })

    useKeyboard((evt: any) => {
        if (props.api.route.current.name !== NAMES.routes.summary) return
        if (props.api.ui?.dialog?.open) return
        const matched = keys ? keys.match("close", evt) : evt.name === "escape"
        if (!matched) return
        evt.preventDefault()
        evt.stopPropagation()
        const sessionID = params().sessionID
        if (sessionID) {
            props.api.route.navigate("session", { sessionID })
        } else {
            props.api.route.navigate("home")
        }
    })

    return (
        <box
            flexDirection="column"
            width="100%"
            height="100%"
            padding={1}
            backgroundColor={palette().surface}
        >
            <box flexDirection="row" gap={1} alignItems="center">
                <box paddingLeft={1} paddingRight={1} backgroundColor={palette().accent}>
                    <text fg={palette().panel}>
                        <b>{LABEL}</b>
                    </text>
                </box>
                <text fg={palette().accent}>
                    <b>{params().topic || "Compression Summary"}</b>
                </text>
            </box>

            <box
                flexGrow={1}
                width="100%"
                marginTop={1}
                border={SINGLE_BORDER}
                borderColor={palette().border}
                padding={1}
                flexDirection="column"
            >
                <text fg={palette().text}>{parsed().body || "(no summary available)"}</text>

                <For each={parsed().sections}>
                    {(section) => <CollapsibleSectionRow section={section} palette={palette()} />}
                </For>
            </box>

            <box marginTop={1}>
                <text {...({ dim: true } as any)} fg={palette().muted}>
                    Press Escape to return
                </text>
            </box>
        </box>
    )
}

export const createSummaryRoute = (api: TuiApi) => ({
    name: NAMES.routes.summary,
    render: () => <SummaryScreen api={api} />,
})
