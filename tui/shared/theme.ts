import type { RGBA } from "@opentui/core"

export type DcpColor = RGBA | string

export interface DcpPalette {
    panel: DcpColor
    base: DcpColor
    surface: DcpColor
    border: DcpColor
    text: DcpColor
    muted: DcpColor
    accent: DcpColor
    success: DcpColor
    warning: DcpColor
}

export type DcpTone = "text" | "muted" | "accent" | "success" | "warning"

const defaults = {
    panel: "#111111",
    base: "#1d1d1d",
    surface: "#171717",
    border: "#4a4a4a",
    text: "#f0f0f0",
    muted: "#a5a5a5",
    accent: "#5f87ff",
    success: "#67b95f",
    warning: "#d7a94b",
}

export const getPalette = (theme: Record<string, unknown>): DcpPalette => {
    const get = (name: string, fallback: string): DcpColor => {
        const value = theme[name]
        if (typeof value === "string") return value
        if (value && typeof value === "object") return value as RGBA
        return fallback
    }

    return {
        panel: get("backgroundPanel", defaults.panel),
        base: get("backgroundElement", defaults.base),
        surface: get("background", defaults.surface),
        border: get("border", defaults.border),
        text: get("text", defaults.text),
        muted: get("textMuted", defaults.muted),
        accent: get("primary", defaults.accent),
        success: get("success", defaults.success),
        warning: get("warning", defaults.warning),
    }
}

export const toneColor = (palette: DcpPalette, tone: DcpTone = "text") => {
    if (tone === "accent") return palette.accent
    if (tone === "success") return palette.success
    if (tone === "warning") return palette.warning
    if (tone === "muted") return palette.muted
    return palette.text
}
