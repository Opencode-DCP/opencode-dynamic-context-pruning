import assert from "node:assert"
import { describe, it } from "node:test"
import { getInvalidConfigKeys, validateConfigTypes } from "../lib/config"

function createConfig(modelLimits?: Record<string, number | string>) {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "minimal",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        turnProtection: {
            enabled: false,
            turns: 0,
        },
        protectedFilePatterns: [],
        tools: {
            settings: {
                nudgeEnabled: true,
                nudgeFrequency: 5,
                protectedTools: [],
                contextLimit: "60%",
                ...(modelLimits !== undefined ? { modelLimits } : {}),
            },
            distill: {
                permission: "allow",
                showDistillation: false,
            },
            compress: {
                permission: "deny",
                showCompression: false,
            },
            prune: {
                permission: "allow",
            },
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

describe("Config Validation - modelLimits", () => {
    it("accepts valid modelLimits configuration", () => {
        const config = createConfig({
            "anthropic/claude-3.5-sonnet": "70%",
            "anthropic/claude-3-opus": 150000,
            "gpt-4": "80%",
        })

        const errors = validateConfigTypes(config)
        assert.strictEqual(errors.length, 0)
    })

    it("rejects invalid modelLimits string value", () => {
        const config = createConfig({
            "anthropic/claude-3.5-sonnet": "invalid",
        })

        const errors = validateConfigTypes(config)
        assert.ok(
            errors.some(
                (error) => error.key === "tools.settings.modelLimits.anthropic/claude-3.5-sonnet",
            ),
        )
    })

    it("rejects modelLimits when not an object", () => {
        const config = createConfig()
        ;(config.tools.settings as any).modelLimits = "not-an-object"

        const errors = validateConfigTypes(config)
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits"))
    })

    it("works without modelLimits", () => {
        const config = createConfig()

        const errors = validateConfigTypes(config)
        assert.strictEqual(errors.length, 0)
    })

    it("rejects malformed percentage strings", () => {
        const config = createConfig({
            model1: "abc%",
            model2: "50 %",
            model3: "%50",
            model4: "50.5.5%",
        })

        const errors = validateConfigTypes(config)
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits.model1"))
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits.model2"))
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits.model3"))
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits.model4"))
    })

    it("rejects strings without percent suffix", () => {
        const config = createConfig({ model: "50" })

        const errors = validateConfigTypes(config)
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits.model"))
    })

    it("rejects empty strings", () => {
        const config = createConfig({ model: "" })

        const errors = validateConfigTypes(config)
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits.model"))
    })

    it("accepts boundary percentages and numbers", () => {
        const config = createConfig({
            p0: "0%",
            p100: "100%",
            n0: 0,
            negative: -50000,
            above100: "150%",
            decimal: "50.5%",
            huge: 1000000000000,
        })

        const errors = validateConfigTypes(config)
        assert.strictEqual(errors.length, 0)
    })

    it("rejects modelLimits arrays", () => {
        const config = createConfig()
        ;(config.tools.settings as any).modelLimits = ["not-an-object"]

        const errors = validateConfigTypes(config)
        assert.ok(errors.some((error) => error.key === "tools.settings.modelLimits"))
    })

    it("does not flag model-specific keys as unknown config keys", () => {
        const config = createConfig({
            "anthropic/claude-3.5-sonnet": "70%",
            "openai/gpt-4o": 120000,
        })

        const invalidKeys = getInvalidConfigKeys(config)
        assert.strictEqual(invalidKeys.length, 0)
    })
})
