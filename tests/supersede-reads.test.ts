import assert from "node:assert/strict"
import test from "node:test"
import { supersedeReads } from "../lib/strategies/supersede-reads"
import { createSessionState } from "../lib/state"
import type { PluginConfig } from "../lib/config"
import { Logger } from "../lib/logger"

function buildConfig(
    overrides?: Partial<PluginConfig["strategies"]["supersedeReads"]>,
): PluginConfig {
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
            permission: "allow",
            showCompression: false,
            maxContextLimit: 100000,
            minContextLimit: 30000,
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
            supersedeReads: {
                enabled: true,
                ...overrides,
            },
            purgeErrors: {
                enabled: true,
                turns: 4,
                protectedTools: [],
            },
        },
    }
}

const logger = new Logger(false)

test("prunes read when same file is subsequently written", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.has("call-read-1"), true, "read should be pruned")
    assert.equal(state.prune.tools.has("call-write-1"), false, "write should not be pruned")
    assert.equal(state.stats.totalPruneTokens, 500)
})

test("prunes read when same file is subsequently edited", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-edit-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/utils.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 800,
    })
    state.toolParameters.set("call-edit-1", {
        tool: "edit",
        parameters: { filePath: "/src/utils.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 200,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.has("call-read-1"), true, "read should be pruned after edit")
    assert.equal(state.stats.totalPruneTokens, 800)
})

test("does not prune read when write comes before it", () => {
    const state = createSessionState()
    state.toolIdList = ["call-write-1", "call-read-1"]
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 300,
    })
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 500,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(
        state.prune.tools.has("call-read-1"),
        false,
        "read after write should not be pruned",
    )
    assert.equal(state.prune.tools.size, 0)
})

test("does not prune read when write targets a different file", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/other.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.size, 0, "no tools should be pruned for different files")
})

test("does not prune read when subsequent write errored", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "error",
        error: "Permission denied",
        turn: 2,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.size, 0, "read should not be pruned when write errored")
})

test("prunes multiple reads for the same file", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-read-2", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-read-2", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 400,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 3,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.has("call-read-1"), true)
    assert.equal(state.prune.tools.has("call-read-2"), true)
    assert.equal(state.stats.totalPruneTokens, 900)
})

test("only prunes reads before the write, not after", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1", "call-read-2"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })
    state.toolParameters.set("call-read-2", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 3,
        tokenCount: 400,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.has("call-read-1"), true, "read before write should be pruned")
    assert.equal(
        state.prune.tools.has("call-read-2"),
        false,
        "read after write should not be pruned",
    )
    assert.equal(state.stats.totalPruneTokens, 500)
})

test("skips already-pruned reads", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })
    // Pre-prune the read
    state.prune.tools.set("call-read-1", 500)

    supersedeReads(state, logger, buildConfig(), [])

    // Token counter should not increase since it was already pruned
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("respects disabled config", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig({ enabled: false }), [])

    assert.equal(state.prune.tools.size, 0, "nothing should be pruned when disabled")
})

test("respects manual mode when automaticStrategies is false", () => {
    const state = createSessionState()
    state.manualMode = "active"
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })

    const config = buildConfig()
    config.manualMode.automaticStrategies = false

    supersedeReads(state, logger, config, [])

    assert.equal(
        state.prune.tools.size,
        0,
        "nothing should be pruned in manual mode without automaticStrategies",
    )
})

test("respects protectedFilePatterns", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-1", "call-write-1"]
    state.toolParameters.set("call-read-1", {
        tool: "read",
        parameters: { filePath: "/src/config.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/config.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })

    const config = buildConfig()
    config.protectedFilePatterns = ["**/*.config.ts", "**/config.ts"]

    supersedeReads(state, logger, config, [])

    assert.equal(state.prune.tools.size, 0, "protected file reads should not be pruned")
})

test("handles multiple files independently", () => {
    const state = createSessionState()
    state.toolIdList = ["call-read-a", "call-read-b", "call-write-a"]
    state.toolParameters.set("call-read-a", {
        tool: "read",
        parameters: { filePath: "/src/a.ts" },
        status: "completed",
        turn: 1,
        tokenCount: 500,
    })
    state.toolParameters.set("call-read-b", {
        tool: "read",
        parameters: { filePath: "/src/b.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 400,
    })
    state.toolParameters.set("call-write-a", {
        tool: "write",
        parameters: { filePath: "/src/a.ts" },
        status: "completed",
        turn: 3,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.has("call-read-a"), true, "read of a.ts should be pruned")
    assert.equal(
        state.prune.tools.has("call-read-b"),
        false,
        "read of b.ts should not be pruned (no write)",
    )
    assert.equal(state.stats.totalPruneTokens, 500)
})

test("handles empty toolIdList gracefully", () => {
    const state = createSessionState()
    state.toolIdList = []

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.size, 0)
})

test("handles tools with no file path parameters", () => {
    const state = createSessionState()
    state.toolIdList = ["call-bash-1", "call-write-1"]
    state.toolParameters.set("call-bash-1", {
        tool: "bash",
        parameters: { command: "ls -la" },
        status: "completed",
        turn: 1,
        tokenCount: 100,
    })
    state.toolParameters.set("call-write-1", {
        tool: "write",
        parameters: { filePath: "/src/index.ts" },
        status: "completed",
        turn: 2,
        tokenCount: 300,
    })

    supersedeReads(state, logger, buildConfig(), [])

    assert.equal(state.prune.tools.size, 0, "non-file tools should not be affected")
})
