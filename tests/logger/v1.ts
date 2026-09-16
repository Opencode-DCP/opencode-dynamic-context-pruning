import type { Plugin } from "@opencode-ai/plugin"
import { Capture } from "./log.js"

let users = 0
let restore: (() => void) | undefined

export const server: Plugin = async () => {
    users++
    if (!restore) {
        const original = globalThis.fetch
        const capture = new Capture()
        const wrapped: typeof fetch = async (input, init) => {
            const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined),
            )
            const sessionID = headers.get("x-opencode-session")
            if (!users || !sessionID) return original(input, init)
            const request = new Request(input, init)
            const scope = { sessionID }
            const id = await capture.request(scope, request)
            try {
                return await capture.response(scope, id, await original(input, init))
            } catch (error) {
                await capture.write(scope, id, "end.json", { type: "http.end", status: "error" })
                throw error
            }
        }
        globalThis.fetch = wrapped
        restore = () => {
            if (globalThis.fetch === wrapped) globalThis.fetch = original
            restore = undefined
        }
    }
    return {
        "chat.headers": async (input, output) => {
            output.headers["x-opencode-session"] = input.sessionID
        },
        dispose: async () => {
            if (--users === 0) restore?.()
        },
    }
}
