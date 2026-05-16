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

test("renderBlockForContext does NOT expand prose (bN) absent from refBlockIds", () => {
    // Regression: v2 block with refBlockIds=[] containing prose (b27) mentions.
    // Previously the renderer regex-scanned summary text and expanded ANY (bN),
    // inflating rendered output (see ses_1d3a77f50ffeaS1NcyP2XlA9lB B28/B29).
    const blocks = new Map<number, BlockLike>([
        [27, { summary: "FULL CONTENT OF B27", refBlockIds: [] }],
        [28, {
            summary: "prompt includes full trap packet decode (b27); also see (b27) again",
            refBlockIds: [],
        }],
    ])

    const result = renderBlockForContext(28, blocks)

    // Prose (b27) stays literal, FULL CONTENT OF B27 is NOT inlined
    assert.equal(
        result.text,
        "prompt includes full trap packet decode (b27); also see (b27) again",
    )
    assert.ok(!result.text.includes("FULL CONTENT OF B27"))
})

test("renderBlockForContext expands refs in refBlockIds even with prose mentions", () => {
    // Counterpoint: when refBlockIds DOES contain the id, all (bN) in summary expand.
    const blocks = new Map<number, BlockLike>([
        [1, { summary: "CHILD", refBlockIds: [] }],
        [2, {
            summary: "sees (b1) once and (b1) twice",
            refBlockIds: [1],
        }],
    ])

    const result = renderBlockForContext(2, blocks)

    assert.equal(result.text, "sees CHILD once and CHILD twice")
})

test("renderBlockForContext mixes allowlisted and prose refs in same summary", () => {
    // Oracle test case: '(b1) plus prose (b2)' with refBlockIds=[1] → b1 expands, b2 stays literal
    const blocks = new Map<number, BlockLike>([
        [1, { summary: "CHILD1", refBlockIds: [] }],
        [2, { summary: "CHILD2", refBlockIds: [] }],
        [3, {
            summary: "(b1) plus prose (b2)",
            refBlockIds: [1],
        }],
    ])

    const result = renderBlockForContext(3, blocks)

    assert.equal(result.text, "CHILD1 plus prose (b2)")
})

test("renderBlockForContext absent refBlockIds do not poison renderedOnce", () => {
    // Oracle regression: refBlockIds contains an id whose (bN) is absent from summary.
    // The earlier draft fix would have called renderInner on b2 (no-op split),
    // mutating renderedOnce. Then a sibling that legitimately references b2 would
    // get '(b2) [already expanded above]' instead of CHILD2.
    const blocks = new Map<number, BlockLike>([
        [1, { summary: "CHILD1", refBlockIds: [] }],
        [2, { summary: "CHILD2", refBlockIds: [] }],
        [3, {
            summary: "(b1) only — but lists b2 in refs too",
            refBlockIds: [1, 2],
        }],
        [4, { summary: "(b2)", refBlockIds: [2] }],
        [5, { summary: "(b3) then (b4)", refBlockIds: [3, 4] }],
    ])

    const result = renderBlockForContext(5, blocks)

    // b3 expands to 'CHILD1 only — but lists b2 in refs too' (b2 not in text)
    // b4 expands to 'CHILD2' — must NOT show 'already expanded above'
    assert.ok(
        result.text.includes("CHILD2"),
        `expected CHILD2 in output, got: ${result.text}`,
    )
    assert.ok(
        !result.text.includes("[already expanded above]"),
        `b2 should not be marked already-expanded, got: ${result.text}`,
    )
})
