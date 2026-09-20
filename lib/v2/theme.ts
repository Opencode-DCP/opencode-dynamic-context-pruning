import type { Theme } from "../tui/types"

type Color = Theme["text"]
type Feedback = "success" | "warning" | "error"
type Action = "primary" | "secondary"

type CurrentTheme = {
    surface(name: "dialog"): {
        text: {
            base: Color
            muted: Color
            action: Record<Action, { base: Color }>
            feedback: Record<Feedback, { base: Color }>
        }
        background: { base: Color; raised: { base: Color } }
        border: { base: Color }
    }
}

type EarlierTheme = {
    contextual: {
        overlay: {
            text: {
                default: Color
                subdued: Color
                action: Record<Action, { default: Color }>
                feedback: Record<Feedback, { default: Color }>
            }
            background: { default: Color; surface: { offset: Color } }
            border: { default: Color }
        }
    }
}

export function panelTheme(source: CurrentTheme | EarlierTheme): Theme {
    if ("surface" in source) {
        const theme = source.surface("dialog")
        return {
            primary: theme.text.action.primary.base,
            accent: theme.text.action.secondary.base,
            text: theme.text.base,
            textMuted: theme.text.muted,
            background: theme.background.base,
            backgroundElement: theme.background.raised.base,
            borderSubtle: theme.border.base,
            selectedListItemText: theme.background.base,
            success: theme.text.feedback.success.base,
            warning: theme.text.feedback.warning.base,
            error: theme.text.feedback.error.base,
        }
    }

    const theme = source.contextual.overlay
    return {
        primary: theme.text.action.primary.default,
        accent: theme.text.action.secondary.default,
        text: theme.text.default,
        textMuted: theme.text.subdued,
        background: theme.background.default,
        backgroundElement: theme.background.surface.offset,
        borderSubtle: theme.border.default,
        selectedListItemText: theme.background.default,
        success: theme.text.feedback.success.default,
        warning: theme.text.feedback.warning.default,
        error: theme.text.feedback.error.default,
    }
}
