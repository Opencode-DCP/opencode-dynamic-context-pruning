import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"

const schema = JSON.parse(readFileSync(new URL("../dcp.schema.json", import.meta.url), "utf-8"))
const learningSchema = schema.properties.compress.properties.learning

test("compression learning schema is opt-in and side-effect free by default", () => {
    assert.deepEqual(learningSchema.default, {
        enabled: false,
        notifications: true,
    })
})

test("compression learning schema accepts only documented settings", () => {
    assert.deepEqual(Object.keys(learningSchema.properties).sort(), ["enabled", "notifications"])
    assert.deepEqual(learningSchema.required.sort(), ["enabled", "notifications"])
    assert.equal(learningSchema.additionalProperties, false)
})

test("compression defaults include learning settings", () => {
    assert.deepEqual(schema.properties.compress.default.learning, learningSchema.default)
})
