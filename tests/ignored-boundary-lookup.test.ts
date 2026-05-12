import assert from "node:assert/strict"
import test from "node:test"
import { createSessionState, type WithParts } from "../lib/state"
import { assignMessageRefs } from "../lib/message-ids"
import { buildSearchContext, resolveBoundaryIds } from "../lib/compress/search"

function msg(id: string, role: "user" | "assistant", opts?: { ignored?: boolean }): WithParts {
    const sessionID = "ses_test"
    const parts: any[] = [
        {
            id: `part-${id}`,
            messageID: id,
            sessionID,
            type: "text" as const,
            text: `content of ${id}`,
            ...(opts?.ignored ? { ignored: true } : {}),
        },
    ]
    const info =
        role === "user"
            ? {
                  id,
                  role,
                  sessionID,
                  agent: "test",
                  model: { providerID: "anthropic", modelID: "claude-test" },
                  time: { created: parseInt(id.replace(/\D/g, "")) || 1 },
              }
            : {
                  id,
                  role,
                  sessionID,
                  agent: "test",
                  time: { created: parseInt(id.replace(/\D/g, "")) || 1 },
              }
    return { info: info as WithParts["info"], parts }
}

test("resolveBoundaryIds resolves ignored user message ref", () => {
    // Simulate: assignMessageRefs ran when parts were NOT ignored (chat.params time),
    // but at compress time, fetchSessionMessages returns parts with ignored:true.
    const state = createSessionState()
    state.sessionId = "ses_test"

    // Messages as they were at chat.params time (no ignored flag)
    const chatParamsMessages = [
        msg("msg-1", "user"),
        msg("msg-2", "assistant"),
        msg("msg-3", "user"),       // will become ignored later
        msg("msg-4", "assistant"),
    ]
    assignMessageRefs(state, chatParamsMessages)

    // At compress time: msg-3 now has parts.ignored = true (opencode marked it)
    const compressTimeMessages = [
        msg("msg-1", "user"),
        msg("msg-2", "assistant"),
        msg("msg-3", "user", { ignored: true }),  // NOW ignored
        msg("msg-4", "assistant"),
    ]
    const context = buildSearchContext(state, compressTimeMessages)

    // m0003 should resolve even though it's now ignored
    const result = resolveBoundaryIds(context, state, "m0003", "m0004")
    assert.equal(result.startReference.messageId, "msg-3")
    assert.equal(result.endReference.messageId, "msg-4")
})

test("resolveBoundaryIds resolves ignored user message as both start and end", () => {
    const state = createSessionState()
    state.sessionId = "ses_test"

    const chatParamsMessages = [
        msg("msg-1", "user"),
        msg("msg-2", "assistant"),
        msg("msg-3", "user"),
    ]
    assignMessageRefs(state, chatParamsMessages)

    const compressTimeMessages = [
        msg("msg-1", "user"),
        msg("msg-2", "assistant"),
        msg("msg-3", "user", { ignored: true }),
    ]
    const context = buildSearchContext(state, compressTimeMessages)

    // Using ignored msg as both start and end (single-message compress)
    const result = resolveBoundaryIds(context, state, "m0003", "m0003")
    assert.equal(result.startReference.messageId, "msg-3")
    assert.equal(result.endReference.messageId, "msg-3")
})

test("resolveBoundaryIds still rejects refs not in byRef", () => {
    const state = createSessionState()
    state.sessionId = "ses_test"

    const messages = [msg("msg-1", "user"), msg("msg-2", "assistant")]
    assignMessageRefs(state, messages)
    const context = buildSearchContext(state, messages)

    // m0099 was never assigned
    assert.throws(
        () => resolveBoundaryIds(context, state, "m0099", "m0002"),
        (err: Error) => err.message.includes("m0099 is not available"),
    )
})

test("compressed block anchored to ignored user message resolves", () => {
    const state = createSessionState()
    state.sessionId = "ses_test"

    // At chat.params time: msg-1 was NOT ignored, refs assigned to all 4
    const chatParamsMessages = [
        msg("msg-1", "user"),
        msg("msg-2", "assistant"),
        msg("msg-3", "user"),
        msg("msg-4", "assistant"),
    ]
    assignMessageRefs(state, chatParamsMessages)

    // Create a compression block anchored to msg-1
    state.prune.messages.blocksById.set(1, {
        blockId: 1,
        runId: 1,
        topic: "test block",
        anchorMessageId: "msg-1",
        active: true,
        memberCount: 2,
        memberIds: [],
        tokenCount: 100,
        summaryTokenCount: 50,
        summary: "test summary",
        createdAt: Date.now(),
        duration: undefined,
    } as any)
    state.prune.messages.activeBlockIds = [1]
    state.prune.messages.nextBlockId = 2

    // At compress time: msg-1 is NOW ignored
    const compressTimeMessages = [
        msg("msg-1", "user", { ignored: true }),
        msg("msg-2", "assistant"),
        msg("msg-3", "user"),
        msg("msg-4", "assistant"),
    ]
    const context = buildSearchContext(state, compressTimeMessages)

    // b1 should resolve even though anchor msg is now ignored
    const result = resolveBoundaryIds(context, state, "b1", "m0004")
    assert.equal(result.startReference.kind, "compressed-block")
    assert.equal((result.startReference as any).anchorMessageId, "msg-1")
})
