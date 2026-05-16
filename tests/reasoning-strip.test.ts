import assert from "node:assert/strict"
import test from "node:test"
import { stripStaleMetadata } from "../lib/messages/reasoning-strip"
import type { WithParts } from "../lib/state"

const SESSION_ID = "ses-reasoning-strip"

type MessagePart = WithParts["parts"][number]
type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>
type TextPart = Extract<MessagePart, { type: "text" }>
type ToolPart = Extract<MessagePart, { type: "tool" }>

function userMessage(modelID = "claude-sonnet-4-5", providerID = "anthropic"): WithParts {
    return {
        info: {
            id: "msg-user",
            sessionID: SESSION_ID,
            role: "user",
            time: { created: 2 },
            agent: "assistant",
            model: { providerID, modelID },
        },
        parts: [textPart("part-user", "msg-user", "next turn")],
    }
}

function assistantMessage(
    parts: MessagePart[],
    modelID = "claude-opus-4-7",
    providerID = "anthropic",
): WithParts {
    return {
        info: {
            id: "msg-assistant",
            sessionID: SESSION_ID,
            role: "assistant",
            time: { created: 1 },
            parentID: "msg-parent",
            modelID,
            providerID,
            mode: "build",
            agent: "assistant",
            path: { cwd: "/tmp/project", root: "/tmp/project" },
            cost: 0,
            tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
            },
        },
        parts,
    }
}

function textPart(
    id: string,
    messageID: string,
    text: string,
    metadata?: Record<string, unknown>,
): TextPart {
    return {
        id,
        sessionID: SESSION_ID,
        messageID,
        type: "text",
        text,
        ...(metadata ? { metadata } : {}),
    }
}

function reasoningPart(text: string, metadata?: Record<string, unknown>): ReasoningPart {
    return {
        id: "part-reasoning",
        sessionID: SESSION_ID,
        messageID: "msg-assistant",
        type: "reasoning",
        text,
        ...(metadata ? { metadata } : {}),
        time: { start: 1, end: 2 },
    }
}

function toolPart(metadata?: Record<string, unknown>): ToolPart {
    return {
        id: "part-tool",
        sessionID: SESSION_ID,
        messageID: "msg-assistant",
        type: "tool",
        callID: "call-tool",
        tool: "bash",
        state: {
            status: "completed",
            input: {},
            output: "ok",
            title: "bash",
            metadata: {},
            time: { start: 1, end: 2 },
        },
        ...(metadata ? { metadata } : {}),
    }
}

test("reasoning.metadata.anthropic.signature preserved when model differs", () => {
    const metadata = { anthropic: { signature: "sig123" } }
    const messages = [assistantMessage([reasoningPart("thinking", metadata)]), userMessage()]

    stripStaleMetadata(messages)

    assert.deepEqual(messages[0].parts[0], reasoningPart("thinking", metadata))
})

test("text/tool metadata still stripped when model differs", () => {
    const messages = [
        assistantMessage([
            textPart("part-text", "msg-assistant", "hello", { provider: "stale" }),
            toolPart({ provider: "stale" }),
        ]),
        userMessage(),
    ]

    stripStaleMetadata(messages)

    assert.equal("metadata" in messages[0].parts[0], false)
    assert.equal("metadata" in messages[0].parts[1], false)
})

test("reasoning with empty text remains untouched", () => {
    const part = reasoningPart("", { anthropic: { signature: "sig-empty" } })
    const messages = [assistantMessage([part]), userMessage()]

    stripStaleMetadata(messages)

    assert.strictEqual(messages[0].parts[0], part)
})

test("sameModel: reasoning untouched", () => {
    const part = reasoningPart("thinking", { anthropic: { signature: "sig-same" } })
    const messages = [assistantMessage([part], "claude-sonnet-4-5"), userMessage()]

    stripStaleMetadata(messages)

    assert.strictEqual(messages[0].parts[0], part)
})
