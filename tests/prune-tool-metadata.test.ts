import assert from "node:assert/strict"
import test from "node:test"
import { prune } from "../lib/messages/prune"
import { createSessionState, type WithParts } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

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
            allowSubAgents: false,
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            maxContextLimit: 150000,
            minContextLimit: 50000,
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectUserMessages: false,
        },
        strategies: {
            deduplication: {
                enabled: true,
                protectedTools: [],
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

function buildMessages(): WithParts[] {
    return [
        {
            info: {
                id: "msg-assistant-edit",
                role: "assistant",
                sessionID: "ses-prune-metadata",
                agent: "assistant",
                time: { created: 1 },
            } as WithParts["info"],
            parts: [
                {
                    id: "part-edit",
                    messageID: "msg-assistant-edit",
                    sessionID: "ses-prune-metadata",
                    type: "tool" as const,
                    tool: "edit",
                    callID: "call-edit-1",
                    state: {
                        status: "completed" as const,
                        input: { filePath: "demo.ts" },
                        output: "edited",
                        metadata: {
                            filediff: {
                                before: "before snapshot",
                                after: "after snapshot",
                                patch: "@@ diff metadata @@",
                            },
                        },
                    },
                },
            ],
        },
    ]
}

test("file snapshot metadata is pruned only for pruned edit or write tools", () => {
    const state = createSessionState()
    const logger = new Logger(false)
    const config = buildConfig()
    const messages = buildMessages()

    prune(state, logger, config, messages)

    const filediff = (messages[0]?.parts[0] as any)?.state?.metadata?.filediff
    assert.equal(filediff.before, "before snapshot")
    assert.equal(filediff.after, "after snapshot")

    state.prune.tools.set("call-edit-1", 1)
    prune(state, logger, config, messages)

    assert.match(filediff.before, /full file snapshot removed/)
    assert.match(filediff.after, /full file snapshot removed/)
    assert.equal(filediff.patch, "@@ diff metadata @@")
})
