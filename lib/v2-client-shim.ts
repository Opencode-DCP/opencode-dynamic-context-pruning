// index.ts's v2 `setup(ctx)` used to do `const client = ctx?.client` and hand
// that straight to every lib/*.ts function that was written against v1's rich
// client (client.session.messages, client.session.get, client.model.list,
// client.tui.showToast, client.session.prompt). In v2's beta plugin API,
// `ctx.client` does not exist at all -- confirmed against the installed
// @opencode-ai/plugin Context type (app/options/agent/aisdk/catalog/command/
// event/integration/plugin/reference/session/shell/skill/tool/websearch, no
// `client` field) -- so that variable was `undefined` for the lifetime of
// every v2 process, and every call site crashed or silently no-op'd the first
// time it was actually exercised.
//
// This shim translates the small number of v1-shaped calls the rest of the
// codebase already makes into the real v2 `ctx` domain calls, so lib/*.ts
// does not need to change call shapes at every site. Where v2 genuinely has
// no equivalent capability (session message history, toast notifications,
// an "ignored, no-reply" chat message), the shim degrades to a cache lookup
// or a clearly-labelled thrown error that existing callers already catch and
// log, rather than crashing with an opaque `undefined is not an object`.
import { getLastKnownMessages } from "./state/message-cache"

export function buildV2ClientCompat(ctx: any) {
    return {
        model: {
            async list() {
                const response = await ctx.catalog.model.list()
                return { data: response?.data ?? [] }
            },
        },
        session: {
            async get(input: { path?: { id?: string }; sessionID?: string }) {
                const sessionID = input?.path?.id ?? input?.sessionID
                const info = await ctx.session.get({ sessionID })
                return { data: info }
            },
            async messages(input: { path?: { id?: string }; sessionID?: string }) {
                const sessionID = input?.path?.id ?? input?.sessionID
                const cached = getLastKnownMessages(sessionID)
                if (!cached) {
                    throw new Error(
                        `Session message history for ${sessionID} is unavailable: the v2 plugin API does not expose session message history to plugins (ctx.session omits messages/export, and there is no ctx.message domain), and no context-hook turn has been observed yet for this session.`,
                    )
                }
                return { data: cached }
            },
            async prompt() {
                // v1's client.session.prompt supported `noReply` + a part-level
                // `ignored` flag to post a silent, non-conversational chat
                // notification. v2's real session.prompt input
                // (sessionID/id/text/files/agents/skills/metadata/delivery/resume)
                // has no equivalent -- calling it would send a real, visible
                // message and solicit an actual model turn. Callers
                // (sendIgnoredMessage) already catch and log this.
                throw new Error(
                    'session.prompt-based chat notifications are not supported by the v2 plugin API (no "ignored"/"no-reply" equivalent); set pruneNotificationType to something other than "chat", or accept that notifications are skipped.',
                )
            },
        },
        // Deliberately no `.tui`: v2's Context has no toast/TUI domain for
        // plugins at all. Its absence is the signal every `client.tui...`
        // call site checks (`typeof client?.tui?.showToast === "function"`)
        // to degrade to a log instead of crashing.
    }
}
