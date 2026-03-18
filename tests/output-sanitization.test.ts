import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { createTextCompleteHandler, createToolExecuteAfterHandler } from "../lib/hooks"
import { injectMessageIds } from "../lib/messages/inject/inject"
import { sanitizeVisibleOutput } from "../lib/messages/utils"
import { createSessionState, type WithParts } from "../lib/state"

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        manualMode: {
            enabled: false,
            automaticStrategies: true,
        },
        turnProtection: {
            enabled: false,
            turns: 4,
        },
        experimental: {
            allowSubAgents: true,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            flatSchema: false,
            protectedTools: [],
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            supersedeWrites: {
                enabled: true,
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

test("sanitizeVisibleOutput strips DCP metadata and trailing blank lines", () => {
    const result = sanitizeVisibleOutput(`bun install
<dcp-message-id>m0045</dcp-message-id>


<dcp-system-reminder>hidden</dcp-system-reminder>
`)

    assert.equal(result, "bun install")
})

test("tool.execute.after strips DCP metadata from visible tool output", async () => {
    const handler = createToolExecuteAfterHandler()
    const output = {
        title: `bash
<dcp-message-id>m0045</dcp-message-id>`,
        output: `bun install v1.3.10
<dcp-message-id>m0045</dcp-message-id>`,
        metadata: {},
    }

    await handler({ tool: "bash", sessionID: "ses_1", callID: "call_1" }, output)

    assert.equal(output.title, "bash")
    assert.equal(output.output, "bun install v1.3.10")
})

test("experimental.text.complete strips DCP metadata from visible assistant text", async () => {
    const handler = createTextCompleteHandler()
    const output = {
        text: `done
<dcp-message-id>m0045</dcp-message-id>
<dcp-system-reminder>hidden</dcp-system-reminder>`,
    }

    await handler({ sessionID: "ses_1", messageID: "msg_1", partID: "part_1" }, output)

    assert.equal(output.text, "done")
})

test("injectMessageIds keeps assistant tool output clean and inserts a synthetic text part", () => {
    const state = createSessionState()
    state.messageIds.byRawId.set("assistant-1", "m0045")

    const messages: WithParts[] = [
        {
            info: {
                id: "assistant-1",
                role: "assistant",
                sessionID: "ses_1",
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "tool-part-1",
                    sessionID: "ses_1",
                    messageID: "assistant-1",
                    type: "tool",
                    callID: "call_1",
                    tool: "bash",
                    state: {
                        status: "completed",
                        input: {},
                        title: "bash",
                        output: "bun install v1.3.10",
                        metadata: {},
                        time: { start: 1, end: 2 },
                    },
                },
            ],
        },
    ]

    injectMessageIds(state, buildConfig(), messages)

    assert.equal(messages[0].parts[0].type, "text")
    assert.equal(messages[0].parts[0].synthetic, true)
    assert.match(messages[0].parts[0].text, /<dcp-message-id>m0045<\/dcp-message-id>/)
    assert.equal(messages[0].parts[1].type, "tool")
    assert.equal(messages[0].parts[1].state.status, "completed")
    assert.equal(messages[0].parts[1].state.output, "bun install v1.3.10")
})
