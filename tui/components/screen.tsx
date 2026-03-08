/** @jsxImportSource @opentui/solid */
import type { DcpPalette } from "../shared/theme"

export const Screen = (props: {
    palette: DcpPalette
    title: string
    subtitle?: string
    footer?: string
    children?: unknown
}) => {
    return (
        <box width="100%" height="100%" backgroundColor={props.palette.panel} padding={1}>
            <box width="100%" height="100%" flexDirection="column" gap={1}>
                <box
                    width="100%"
                    flexDirection="column"
                    gap={1}
                    padding={1}
                    backgroundColor={props.palette.base}
                    border={["left"]}
                    borderColor={props.palette.accent}
                >
                    <text fg={props.palette.text}>
                        <b>{props.title}</b>
                    </text>
                    {props.subtitle && <text fg={props.palette.muted}>{props.subtitle}</text>}
                </box>
                <box width="100%" flexDirection="column" gap={1} flexGrow={1}>
                    {props.children}
                </box>
                {props.footer && <text fg={props.palette.muted}>{props.footer}</text>}
            </box>
        </box>
    )
}
