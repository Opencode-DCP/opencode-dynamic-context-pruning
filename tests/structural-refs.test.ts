import assert from "node:assert/strict"
import test from "node:test"

import {
    extractBlockPlaceholders,
    formatBlockPlaceholder,
    parseBlockPlaceholder,
} from "../lib/message-ids"
import { DAGValidationError, validateBlockRefs } from "../lib/compress/dag"
import { renderBlockForContext, type BlockLike } from "../lib/compress/renderer"

test("formatBlockPlaceholder uses parenthesized form", () => {
    assert.equal(formatBlockPlaceholder(7), "(b7)")
})

test("parseBlockPlaceholder accepts only parenthesized refs", () => {
    assert.equal(parseBlockPlaceholder("(b7)"), 7)
    assert.equal(parseBlockPlaceholder("b7"), null)
})

test("extractBlockPlaceholders returns block ids in order", () => {
    assert.deepEqual(extractBlockPlaceholders("see (b1) and (b3)"), [1, 3])
})

test("validateBlockRefs throws on self reference", () => {
    assert.throws(
        () => validateBlockRefs(3, [3], new Map<number, unknown>()),
        (err: unknown) => err instanceof DAGValidationError && /self-ref/.test(String(err.message)),
    )
})

test("validateBlockRefs throws on forward reference", () => {
    assert.throws(
        () => validateBlockRefs(3, [4], new Map<number, unknown>()),
        (err: unknown) => err instanceof DAGValidationError && /forward-ref/.test(String(err.message)),
    )
})

test("renderBlockForContext expands a linear chain once", () => {
    const blocks = new Map<number, BlockLike>([
        [1, { summary: "A", refBlockIds: [] }],
        [2, { summary: "(b1) B", refBlockIds: [1] }],
        [3, { summary: "(b2) C", refBlockIds: [2] }],
    ])

    const result = renderBlockForContext(3, blocks)

    assert.equal(result.text, "A B C")
})

test("renderBlockForContext dedups diamonds with already expanded marker", () => {
    const blocks = new Map<number, BlockLike>([
        [1, { summary: "X", refBlockIds: [] }],
        [2, { summary: "(b1) D", refBlockIds: [1] }],
        [3, { summary: "(b1) E", refBlockIds: [1] }],
        [4, { summary: "(b2) + (b3)", refBlockIds: [2, 3] }],
    ])

    const result = renderBlockForContext(4, blocks)

    assert.equal(result.text, "X D + (b1) [already expanded above] E")
})

test("renderBlockForContext returns legacy v1 summaries verbatim", () => {
    const blocks = new Map<number, BlockLike>([[1, { summary: "legacy (b9) text" }]])

    const result = renderBlockForContext(1, blocks)

    assert.equal(result.text, "legacy (b9) text")
})

test("renderBlockForContext marks missing blocks", () => {
    const blocks = new Map<number, BlockLike>()

    const result = renderBlockForContext(42, blocks)

    assert.equal(result.text, "(b42) [not found]")
})
