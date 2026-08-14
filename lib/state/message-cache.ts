// v2's plugin `Context` does not expose session message history to plugins at
// all: `ctx.session` only picks `create | get | prompt | generate | command |
// synthetic | interrupt | hook` off the full `SessionApi` (confirmed against
// @opencode-ai/plugin's promise/session.d.ts) -- `.messages`/`.export` are not
// among them, and there is no separate `ctx.message` domain on `Context`
// either, even though `MessageApi.list({sessionID})` exists on the full
// client. The only place a v2 plugin legitimately sees message content is the
// `messages` array handed to it live inside `ctx.session.hook("context", ...)`.
//
// This module lets `createChatMessageTransformHandler` (which runs on every
// context-hook turn, for every session including subagent sub-sessions) stash
// the messages it was given, keyed by session ID, so anything that needs a
// session's message history later in the same process (the compress tool,
// subagent output expansion) can read it back instead of calling a client
// method that doesn't exist under v2. Under v1, this cache is unused --
// `fetchSessionMessages`/`fetchSubAgentMessages` call the real
// `client.session.messages(...)` first and only fall back to this cache when
// that capability is unavailable.

const cache = new Map<string, unknown[]>()

export function setLastKnownMessages(
    sessionID: string | undefined | null,
    messages: unknown[],
): void {
    if (!sessionID || !Array.isArray(messages)) {
        return
    }
    cache.set(sessionID, messages)
}

export function getLastKnownMessages(sessionID: string | undefined | null): unknown[] | undefined {
    if (!sessionID) {
        return undefined
    }
    return cache.get(sessionID)
}

/** Test-only: reset cache state between test files. */
export function clearMessageCache(): void {
    cache.clear()
}
