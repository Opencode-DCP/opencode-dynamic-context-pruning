/** @jsxImportSource @opentui/solid */
import type { DcpPalette } from "../shared/theme"

export const Section = (props: {
    palette: DcpPalette
    title: string
    subtitle?: string
    children?: unknown
}) => {
    return (
        <box
            width="100%"
            flexDirection="column"
            gap={1}
            padding={1}
            backgroundColor={props.palette.base}
            border={["left"]}
            borderColor={props.palette.border}
        >
            <text fg={props.palette.text}>
                <b>{props.title}</b>
            </text>
            {props.subtitle && <text fg={props.palette.muted}>{props.subtitle}</text>}
            <box width="100%" flexDirection="column" gap={1}>
                {props.children}
            </box>
        </box>
    )
}
