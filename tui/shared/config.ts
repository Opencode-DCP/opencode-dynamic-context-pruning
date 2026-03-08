import type { DcpTuiConfig } from "./types"

const pick = (value: unknown, fallback: string) => {
    if (typeof value !== "string") return fallback
    if (!value.trim()) return fallback
    return value
}

export const readConfig = (options: Record<string, unknown> | undefined): DcpTuiConfig => {
    return {
        label: pick(options?.label, "DCP"),
        route: pick(options?.route, "dcp"),
    }
}
