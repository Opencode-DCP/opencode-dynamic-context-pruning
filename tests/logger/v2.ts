import type { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { Capture, type Scope } from "./log.js"

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
    const capture = new Capture(
        typeof ctx.options.directory === "string" ? ctx.options.directory : undefined,
    )
    const requests = new WeakMap<Request, string>()
    const scope = (event: Scope): Scope => ({
        sessionID: event.sessionID,
        kind: event.kind,
        agent: event.agent,
        model: event.model,
    })

    for (const kind of ["context", "compaction", "generate", "title"] as const) {
        await ctx.session.hook(kind, async (event) => {
            await capture.write(
                { ...scope(event), kind: kind === "context" ? "primary" : kind },
                randomUUID(),
                "context.json",
                {
                    type: "context",
                    system: event.system,
                    messages: event.messages,
                    options: event.options,
                    ...("tools" in event ? { tools: event.tools } : {}),
                },
            )
        })
    }
    await ctx.session.hook("http.request", async (event) => {
        requests.set(event.request, await capture.request(scope(event), event.request))
    })
    await ctx.session.hook("http.response", async (event) => {
        // Another plugin can replace the Request after our request hook.
        const id =
            requests.get(event.request) ?? (await capture.request(scope(event), event.request))
        event.response = await capture.response(scope(event), id, event.response)
    })
    await ctx.session.hook("experimental.ws.handshake", async (event) => {
        const url = event.url
        if (typeof ctx.options.relay === "string") {
            const relay = new URL(ctx.options.relay)
            relay.pathname = "/relay"
            relay.searchParams.set("upstream", url)
            relay.searchParams.set("session", event.sessionID)
            relay.searchParams.set("kind", event.kind)
            event.url = relay.href
        }
        await capture.write(scope(event), randomUUID(), "handshake.json", {
            type: "ws.handshake",
            url,
            relayed: event.url !== url,
        })
    })
}
