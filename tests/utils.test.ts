import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { normalizeCompressArgs, validateCompressArgs } from "../lib/tools/utils"

describe("normalizeCompressArgs", () => {
    test("flat schema: maps top-level fields into content object", () => {
        const args = {
            topic: "Auth Exploration",
            startId: "m0001",
            endId: "m0010",
            summary: "Explored auth system.",
        }
        const result = normalizeCompressArgs(args)
        assert.equal(result.topic, "Auth Exploration")
        assert.equal(result.content.startId, "m0001")
        assert.equal(result.content.endId, "m0010")
        assert.equal(result.content.summary, "Explored auth system.")
    })

    test("nested schema: extracts fields from content object", () => {
        const args = {
            topic: "Auth Exploration",
            content: {
                startId: "m0001",
                endId: "m0010",
                summary: "Explored auth system.",
            },
        }
        const result = normalizeCompressArgs(args)
        assert.equal(result.content.startId, "m0001")
        assert.equal(result.content.endId, "m0010")
        assert.equal(result.content.summary, "Explored auth system.")
    })

    // Regression test: LLM sends nested content object but omits startId inside it.
    // Before fix: blind cast caused validateCompressArgs to throw
    // "content.startId is required and must be a non-empty string"
    // After fix: normalizeCompressArgs falls back to top-level startId if present,
    // or produces empty string that validateCompressArgs rejects with the same clear message.
    test("nested schema with missing startId: replicates original bug — validateCompressArgs throws expected error", () => {
        const args = {
            topic: "Auth Exploration",
            content: {
                // startId intentionally omitted — common LLM malformation
                endId: "m0010",
                summary: "Explored auth system.",
            },
        }
        const normalized = normalizeCompressArgs(args)
        assert.throws(
            () => validateCompressArgs(normalized),
            (err: Error) => {
                assert.equal(
                    err.message,
                    "content.startId is required and must be a non-empty string",
                )
                return true
            },
        )
    })

    test("hybrid args: startId missing from content but present at top-level — recovered after fix", () => {
        // LLM confused the schema and put startId at top level despite using nested format
        const args = {
            topic: "Auth Exploration",
            startId: "m0001",
            content: {
                // startId missing from content
                endId: "m0010",
                summary: "Explored auth system.",
            },
        }
        const result = normalizeCompressArgs(args)
        assert.equal(result.content.startId, "m0001")
        assert.equal(result.content.endId, "m0010")
    })

    test("content is an array (hallucinated): falls back gracefully to top-level fields", () => {
        const args = {
            topic: "Auth Exploration",
            startId: "m0001",
            endId: "m0010",
            summary: "Explored auth system.",
            content: ["m0001", "m0010", "summary text"],
        }
        const result = normalizeCompressArgs(args as unknown as Record<string, unknown>)
        assert.equal(result.content.startId, "m0001")
        assert.equal(result.content.endId, "m0010")
    })

    // Regression test: framework passes nested content as a JSON string instead of a parsed object.
    // This is the actual root cause of the error in live sessions — opencode serializes nested
    // tool schema args to strings before passing them to the plugin's execute handler.
    test("content as JSON string: parsed and extracted correctly", () => {
        const args = {
            topic: "Auth Exploration",
            content: JSON.stringify({
                startId: "m0001",
                endId: "m0010",
                summary: "Explored auth system.",
            }),
        }
        const result = normalizeCompressArgs(args as unknown as Record<string, unknown>)
        assert.equal(result.content.startId, "m0001")
        assert.equal(result.content.endId, "m0010")
        assert.equal(result.content.summary, "Explored auth system.")
    })

    test("content as invalid JSON string: falls back to empty strings, validateCompressArgs throws", () => {
        const args = {
            topic: "Auth Exploration",
            content: "not-json",
        }
        const normalized = normalizeCompressArgs(args as unknown as Record<string, unknown>)
        assert.throws(
            () => validateCompressArgs(normalized),
            (err: Error) => {
                assert.equal(
                    err.message,
                    "content.startId is required and must be a non-empty string",
                )
                return true
            },
        )
    })

    // Intersection of both failure modes: framework serializes content to JSON string AND
    // the LLM omitted a required field inside it. Most realistic real-world failure scenario.
    test("content as JSON string with missing startId: parsed but validateCompressArgs throws", () => {
        const args = {
            topic: "Auth Exploration",
            content: JSON.stringify({ endId: "m0010", summary: "Explored auth system." }),
        }
        const normalized = normalizeCompressArgs(args as unknown as Record<string, unknown>)
        assert.equal(normalized.content.startId, "")
        assert.throws(
            () => validateCompressArgs(normalized),
            (err: Error) => {
                assert.equal(
                    err.message,
                    "content.startId is required and must be a non-empty string",
                )
                return true
            },
        )
    })

    test("validateCompressArgs passes on well-formed normalized args", () => {
        const args = normalizeCompressArgs({
            topic: "Auth Exploration",
            content: { startId: "m0001", endId: "m0010", summary: "Explored auth system." },
        })
        assert.doesNotThrow(() => validateCompressArgs(args))
    })
})
