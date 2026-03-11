/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import type { DcpPalette } from "../shared/theme"

const SINGLE_BORDER = { type: "single" } as any

export const Section = (props: {
    palette: DcpPalette
    title: string
    subtitle?: string
    children?: JSX.Element
}) => {
    return (
        <box
            width="100%"
            flexDirection="column"
            gap={1}
            padding={1}
            backgroundColor={props.palette.base}
            border={SINGLE_BORDER}
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
