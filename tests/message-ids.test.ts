import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { Logger } from "../lib/logger"
import { assignMessageRefs } from "../lib/message-ids"
import { checkSession, createSessionState, type WithParts } from "../lib/state"

function buildConfig(permission: "allow" | "ask" | "deny" = "allow"): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "message",
            permission,
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
        },
    }
}

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

test("checkSession resets message id aliases after native compaction", async () => {
    const sessionID = `ses_message_ids_after_compaction_${Date.now()}`
    const messages = buildCompactedMessages(sessionID)
    const state = createSessionState()
    const logger = new Logger(false)

    state.sessionId = sessionID
    state.messageIds.byRawId.set("old-message-9998", "m9998")
    state.messageIds.byRawId.set("old-message-9999", "m9999")
    state.messageIds.byRef.set("m9998", "old-message-9998")
    state.messageIds.byRef.set("m9999", "old-message-9999")
    state.messageIds.nextRef = 9999

    await checkSession({} as any, state, logger, messages, false)

    assert.equal(state.lastCompaction, 2)
    assert.equal(state.messageIds.byRawId.size, 0)
    assert.equal(state.messageIds.byRef.size, 0)
    assert.equal(state.messageIds.nextRef, 1)

    const assigned = assignMessageRefs(state, messages)

    assert.equal(assigned, 2)
    assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0001")
    assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0002")
    assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-summary")
    assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-follow-up")
    assert.equal(state.messageIds.nextRef, 3)
})

test("assignMessageRefs after prune prevents orphan aliases (RED->GREEN: fails on old pipeline order)", async () => {
    const sessionID = "ses_alias_leak_test"
    const state = createSessionState()
    const logger = new Logger(false)

    // Prevent checkSession from resetting state via ensureSessionInitialized
    state.sessionId = sessionID

    // Simulate a completed compress — this message should be removed by prune
    state.prune.messages.byMessageId.set("msg-pruned", {
        tokenCount: 100,
        allBlockIds: [1],
        activeBlockIds: [1],
    })

    const messages: WithParts[] = [
        {
            info: {
                id: "msg-user",
                role: "user",
                sessionID,
                agent: "assistant",
                model: { providerID: "anthropic", modelID: "claude-test" },
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-user-part",
                    messageID: "msg-user",
                    sessionID,
                    type: "text",
                    text: "Test message",
                },
            ],
        },
        {
            info: {
                id: "msg-assistant-survivor",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 2 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-assistant-survivor-part",
                    messageID: "msg-assistant-survivor",
                    sessionID,
                    type: "text",
                    text: "Survivor response",
                },
            ],
        },
        {
            info: {
                id: "msg-pruned",
                role: "assistant",
                sessionID,
                agent: "assistant",
                time: { created: 3 },
            } as WithParts["info"],
            parts: [
                {
                    id: "msg-pruned-part",
                    messageID: "msg-pruned",
                    sessionID,
                    type: "text",
                    text: "Will be removed",
                },
            ],
        },
    ]

    const handler = createChatMessageTransformHandler(
        {} as any,
        state,
        logger,
        buildConfig("allow"),
        {
            reload() {},
            getRuntimePrompts() {
                return {} as any
            },
        } as any,
        { global: undefined, agents: {} },
    )

    await handler({}, { messages })

    // Survivors get aliases
    assert.ok(state.messageIds.byRawId.has("msg-user"), "user message should have alias")
    assert.ok(state.messageIds.byRawId.has("msg-assistant-survivor"), "survivor should have alias")

    // RED on old pipeline (assignMessageRefs before prune): msg-pruned got an alias before
    //   being removed, and no cleanup follows → assertion FAILS (alias leak detected)
    // GREEN on new pipeline (assignMessageRefs after prune): prune removes msg-pruned first,
    //   then assignMessageRefs never sees it → assertion PASSES (no leak)
    assert.ok(
        !state.messageIds.byRawId.has("msg-pruned"),
        "pruned message should NOT have an alias — leak if it does",
    )
})
