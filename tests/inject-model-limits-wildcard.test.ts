import assert from "node:assert"
import { describe, it } from "node:test"
import { findModelLimit } from "../lib/messages/inject"

describe("findModelLimit", () => {
    it("prefers exact matches over wildcard matches", () => {
        const modelLimits = {
            "ollama/zen-1": "35%",
            "*/zen-1": "40%",
        }

        const limit = findModelLimit("ollama/zen-1", modelLimits)
        assert.strictEqual(limit, "35%")
    })

    it("matches provider wildcard patterns", () => {
        const modelLimits = {
            "*/zen-1": "40%",
        }

        const limit = findModelLimit("opencode/zen-1", modelLimits)
        assert.strictEqual(limit, "40%")
    })

    it("matches model wildcard patterns", () => {
        const modelLimits = {
            "ollama/*": "25%",
        }

        const limit = findModelLimit("ollama/zen-3", modelLimits)
        assert.strictEqual(limit, "25%")
    })

    it("matches substring wildcard patterns", () => {
        const modelLimits = {
            "*sonnet*": 120000,
        }

        const limit = findModelLimit("anthropic/claude-3.5-sonnet", modelLimits)
        assert.strictEqual(limit, 120000)
    })

    it("prefers the most specific wildcard pattern", () => {
        const modelLimits = {
            "*sonnet*": "45%",
            "ollama/*": "25%",
        }

        const limit = findModelLimit("ollama/sonnet", modelLimits)
        assert.strictEqual(limit, "25%")
    })

    it("uses lexical order as deterministic tiebreaker", () => {
        const modelLimits = {
            "a*": 100,
            "*a": 200,
        }

        const limit = findModelLimit("a", modelLimits)
        assert.strictEqual(limit, 200)
    })

    it("returns undefined when no pattern matches", () => {
        const modelLimits = {
            "ollama/*": "25%",
        }

        const limit = findModelLimit("openai/gpt-5", modelLimits)
        assert.strictEqual(limit, undefined)
    })
})
