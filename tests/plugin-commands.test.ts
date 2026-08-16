import assert from "node:assert/strict"
import test from "node:test"
import type { PluginConfig } from "../lib/config"
import { registerOpencodeCommands } from "../lib/commands/register"

function buildConfig(permission: "allow" | "deny" = "allow"): PluginConfig {
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
    } as PluginConfig
}

test("registerOpencodeCommands exposes /dcp and /dcp-compress", () => {
    const opencodeConfig: Record<string, unknown> = {}
    registerOpencodeCommands(opencodeConfig, buildConfig("allow"))

    const commands = opencodeConfig.command as Record<string, { description: string }>
    assert.ok(commands.dcp)
    assert.match(commands.dcp.description, /\/dcp manual/)
    assert.ok(commands["dcp-compress"])
})

test("registerOpencodeCommands skips commands when compress is denied", () => {
    const opencodeConfig: Record<string, unknown> = {}
    registerOpencodeCommands(opencodeConfig, buildConfig("deny"))

    assert.equal(opencodeConfig.command, undefined)
})
