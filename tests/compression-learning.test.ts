import assert from "node:assert/strict"
import test from "node:test"
import { appendCompressionLearning } from "../lib/prompts/extensions/learning"
import type { CompressionLearningConfig } from "../lib/config"

const BASE_PROMPT = "Custom compression instructions."

function config(overrides: Partial<CompressionLearningConfig> = {}): CompressionLearningConfig {
    return {
        enabled: true,
        notifications: true,
        ...overrides,
    }
}

test("disabled compression learning leaves the effective prompt unchanged", () => {
    const result = appendCompressionLearning(BASE_PROMPT, config({ enabled: false }))

    assert.equal(result, BASE_PROMPT)
})

test("learning appends durable criteria and project-policy guidance", () => {
    const result = appendCompressionLearning(BASE_PROMPT, config())

    assert.ok(result.startsWith(BASE_PROMPT))
    assert.match(result, /LEARN BEFORE COMPRESSION/)
    assert.match(result, /hidden relationships between files or modules/)
    assert.match(result, /follow any learning policy present in the system or project instructions/)
    assert.match(result, /do not override more specific project learning rules/)
    assert.match(result, /Initialized pre-compression learning\./)
})

test("learning persists findings according to project policy", () => {
    const result = appendCompressionLearning(BASE_PROMPT, config())

    assert.match(result, /narrowest applicable directory/)
    assert.match(result, /follow the project's persistence policy/)
    assert.match(result, /nearest appropriate AGENTS\.md/)
    assert.match(
        result,
        /Do not create or edit guidance files when there is no durable new learning/,
    )
})

test("notifications can be disabled independently", () => {
    const result = appendCompressionLearning(BASE_PROMPT, config({ notifications: false }))

    assert.match(result, /LEARN BEFORE COMPRESSION/)
    assert.doesNotMatch(result, /Initialized pre-compression learning\./)
    assert.doesNotMatch(result, /Learning is finished/)
})
