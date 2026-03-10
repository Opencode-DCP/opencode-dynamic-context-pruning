/** @jsxImportSource @opentui/solid */
import { toneColor, type DcpPalette, type DcpTone } from "../shared/theme"

const pad = (value: string, width: number) => {
    if (value.length >= width) return value
    return value.padEnd(width, " ")
}

export const MetricRow = (props: {
    palette: DcpPalette
    label: string
    value: string
    tone?: DcpTone
}) => {
    return (
        <text
            fg={toneColor(props.palette, props.tone)}
        >{`${pad(props.label, 18)} ${props.value}`}</text>
    )
}
