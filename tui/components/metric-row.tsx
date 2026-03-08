/** @jsxImportSource @opentui/solid */
import type { DcpPalette } from "../shared/theme"

const pad = (value: string, width: number) => {
    if (value.length >= width) return value
    return value.padEnd(width, " ")
}

export const MetricRow = (props: {
    palette: DcpPalette
    label: string
    value: string
    tone?: "text" | "muted" | "accent"
}) => {
    const fg =
        props.tone === "accent"
            ? props.palette.accent
            : props.tone === "muted"
              ? props.palette.muted
              : props.palette.text

    return <text fg={fg}>{`${pad(props.label, 18)} ${props.value}`}</text>
}
