import { describe, it } from "node:test"
import assert from "node:assert"
import { readFile } from "fs/promises"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe("Schema Validation - modelLimits", () => {
    it("should accept valid modelLimits configuration", async () => {
        const schema = JSON.parse(await readFile(join(__dirname, "../dcp.schema.json"), "utf-8"))
        const modelLimitsSchema =
            schema.properties?.tools?.properties?.settings?.properties?.modelLimits

        assert.ok(modelLimitsSchema, "modelLimits field should exist")
        assert.strictEqual(modelLimitsSchema.type, "object")
        assert.ok(modelLimitsSchema.additionalProperties)
        assert.ok(modelLimitsSchema.additionalProperties.oneOf)
        assert.strictEqual(modelLimitsSchema.additionalProperties.oneOf.length, 2)
    })

    it("should support number values in modelLimits", async () => {
        const schema = JSON.parse(await readFile(join(__dirname, "../dcp.schema.json"), "utf-8"))
        const numberSchema =
            schema.properties?.tools?.properties?.settings?.properties?.modelLimits
                ?.additionalProperties?.oneOf?.[0]

        assert.ok(numberSchema, "number schema should exist")
        assert.strictEqual(numberSchema.type, "number")
    })

    it("should support percentage strings in modelLimits", async () => {
        const schema = JSON.parse(await readFile(join(__dirname, "../dcp.schema.json"), "utf-8"))
        const percentSchema =
            schema.properties?.tools?.properties?.settings?.properties?.modelLimits
                ?.additionalProperties?.oneOf?.[1]

        assert.ok(percentSchema, "percentage schema should exist")
        assert.strictEqual(percentSchema.type, "string")
        assert.ok(percentSchema.pattern)
        assert.strictEqual(percentSchema.pattern, "^\\d+(?:\\.\\d+)?%$")
    })

    // Test valid percentage patterns
    it("should accept valid percentage patterns", async () => {
        const schema = JSON.parse(await readFile(join(__dirname, "../dcp.schema.json"), "utf-8"))
        const pattern =
            schema.properties?.tools?.properties?.settings?.properties?.modelLimits
                ?.additionalProperties?.oneOf?.[1]?.pattern

        const validPatterns = ["0%", "50%", "100%", "50.5%", "0.1%", "99.99%", "1000%"]
        const regex = new RegExp(pattern)

        for (const test of validPatterns) {
            assert.ok(regex.test(test), `Should accept: ${test}`)
        }
    })

    it("should reject invalid percentage patterns", async () => {
        const schema = JSON.parse(await readFile(join(__dirname, "../dcp.schema.json"), "utf-8"))
        const pattern =
            schema.properties?.tools?.properties?.settings?.properties?.modelLimits
                ?.additionalProperties?.oneOf?.[1]?.pattern

        const invalidPatterns = [
            "abc%", // non-numeric
            "50 %", // space before %
            "%50", // % before number
            "50.5.5%", // multiple decimals
            "%%", // no number
            "", // empty string
            "50", // no %
            "-50%", // negative (regex doesn't support -)
            ".5%", // starts with decimal
            "50.%", // decimal without fraction
        ]
        const regex = new RegExp(pattern)

        for (const test of invalidPatterns) {
            assert.ok(!regex.test(test), `Should reject: ${test}`)
        }
    })
})
