import type { TuiApi } from "@opencode-ai/plugin/tui"
import type { DcpRouteNames } from "./names"
import type { DcpRouteParams, DcpRouteSource } from "./types"

export const getSessionIDFromParams = (params?: Record<string, unknown>) => {
    if (typeof params?.session_id === "string") return params.session_id
    return undefined
}

export const getRouteSource = (params?: Record<string, unknown>) => {
    if (typeof params?.source === "string") return params.source
    return "unknown"
}

export const getCurrentSessionID = (api: TuiApi) => {
    const current = api.route.current
    if (current.name === "session") return current.params.sessionID
    if ("params" in current && current.params && typeof current.params === "object") {
        return getSessionIDFromParams(current.params)
    }
    return undefined
}

const navigate = (api: TuiApi, routeName: string, source: DcpRouteSource, sessionID?: string) => {
    const params: DcpRouteParams = {
        source,
        session_id: sessionID ?? getCurrentSessionID(api),
    }
    api.route.navigate(routeName, params)
}

export const openPanel = (
    api: TuiApi,
    names: DcpRouteNames,
    source: DcpRouteSource,
    sessionID?: string,
) => {
    navigate(api, names.routes.panel, source, sessionID)
}

export const goBack = (api: TuiApi, sessionID?: string) => {
    if (sessionID) {
        api.route.navigate("session", { sessionID })
        return
    }
    api.route.navigate("home")
}
