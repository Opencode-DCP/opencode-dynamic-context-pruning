import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

function textPart(messageID: string, sessionID: string, id: string, text: string) {
    return {
        id,
        messageID,
        sessionID,
        type: "text" as const,
        text,
    }
}

function buildCompactedMessages(sessionID: string): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-summary",
                role: "assistant",
                sessionID,
                agent: "assistant",
                summary: true,
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-assistant-summary",
                    sessionID,
                    "msg-assistant-summary-part",
                    "Compaction summary",
                ),
            ],
        },
        {
            info: {
                id: "msg-user-follow-up",
                role: "user",
                sessionID,
                agent: "assistant",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-test",
                },
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                textPart(
                    "msg-user-follow-up",
                    sessionID,
                    "msg-user-follow-up-part",
                    "Continue after compaction",
                ),
            ],
        },
    ]
}

test("checkSession preserves message id aliases after native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    state.messageIds.byRawId.set("old-message-1", "m0001")
    state.messageIds.byRawId.set("old-message-2", "m0002")
    state.messageIds.byRef.set("m0001", "old-message-1")
    state.messageIds.byRef.set("m0002", "old-message-2")
    state.messageIds.nextRef = 3

    await checkSession({} as any, state, logger, messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.get("old-message-1"), "m0001")
    assert.equal(state.messageIds.byRawId.get("old-message-2"), "m0002")
    assert.equal(state.messageIds.byRef.get("m0001"), "old-message-1")
    assert.equal(state.messageIds.byRef.get("m0002"), "old-message-2")
    assert.equal(state.messageIds.nextRef, 3)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 2)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0003")
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0004")
    assert.equal(state.messageIds.byRef.get("m0003"), "msg-assistant-summary")
    assert.equal(state.messageIds.byRef.get("m0004"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 5)
})
