import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"

const testDataHome = join(tmpdir(), `opencode-dcp-exact-dedup-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-exact-dedup-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

import {
    COMPRESSED_BLOCK_HEADER,
    deduplicateBlockContent,
    extractBlockBody,
    stripCompactMarkers,
    type ConsumedBlock,
} from "../lib/compress/dedup"
import { wrapBlockSummary } from "../lib/compress/state"
import type { BlockLike } from "../lib/compress/renderer"

function makeConsumed(id: number, innerBody: string): ConsumedBlock {
    return {
        id,
        summary: wrapBlockSummary(id, innerBody),
        schemaVersion: 1,
    }
}

test("exact-substring dedup replaces inline body and records refBlockId", () => {
    const consumed: ConsumedBlock[] = [makeConsumed(1, "foo bar baz")]
    const modelSummary = "prefix foo bar baz suffix"
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: consumed[0].summary }],
    ])

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, "prefix (b1) suffix")
    assert.deepEqual(result.refBlockIds, [1])
})

test("longest-first ordering: longer body matched before shorter substring", () => {
    // b1's body "foo bar" is a substring of b2's body "foo bar baz qux".
    // The model summary embeds b2's full body. If shortest-first ran, b1
    // would match against the "foo bar" prefix and leave "(b1) baz qux"
    // behind. Longest-first must collapse the whole span to "(b2)" and
    // leave b1 unmatched (refBlockIds = [2]).
    const consumed: ConsumedBlock[] = [
        makeConsumed(1, "foo bar"),
        makeConsumed(2, "foo bar baz qux"),
    ]
    const modelSummary = "before foo bar baz qux after"
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: consumed[0].summary }],
        [2, { summary: consumed[1].summary }],
    ])

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, "before (b2) after")
    assert.deepEqual(result.refBlockIds, [2])
    assert.ok(!result.deduped.includes("(b1)"), "b1 must not be inserted")
})

test("no match: unchanged summary and empty refBlockIds", () => {
    const consumed: ConsumedBlock[] = [makeConsumed(1, "specific phrase that never appears")]
    const modelSummary = "totally different content with no overlap"
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: consumed[0].summary }],
    ])

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, modelSummary)
    assert.deepEqual(result.refBlockIds, [])
})

test("multiple consumed blocks deduped in one pass", () => {
    const consumed: ConsumedBlock[] = [
        makeConsumed(1, "alpha section body"),
        makeConsumed(2, "beta section body"),
    ]
    const modelSummary = "intro alpha section body middle beta section body outro"
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: consumed[0].summary }],
        [2, { summary: consumed[1].summary }],
    ])

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, "intro (b1) middle (b2) outro")
    // Order: bodies have the same length, so insertion order is sort-stable
    // and matches the input order after the longest-first sort settled.
    assert.equal(result.refBlockIds.length, 2)
    assert.ok(result.refBlockIds.includes(1))
    assert.ok(result.refBlockIds.includes(2))
})

test("each consumed block replaced at most once (first occurrence only)", () => {
    // String.replace with a string searchValue substitutes the FIRST
    // occurrence only. If the model duplicates a body in its summary the
    // second occurrence stays inline rather than turning into a second (b1).
    const consumed: ConsumedBlock[] = [makeConsumed(1, "echo body")]
    const modelSummary = "echo body and then echo body again"
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: consumed[0].summary }],
    ])

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, "(b1) and then echo body again")
    assert.deepEqual(result.refBlockIds, [1])
})

test("empty consumed body is skipped", () => {
    const consumed: ConsumedBlock[] = [makeConsumed(1, "")]
    const modelSummary = "anything goes here"
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: consumed[0].summary }],
    ])

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, modelSummary)
    assert.deepEqual(result.refBlockIds, [])
})

test("rendered-content leak detection replaces full DAG expansion", () => {
    // v2 chain: b1 → "alpha". b2 → "(b1) bridge". Rendered b2 = "alpha bridge".
    // The model summary inlines the RENDERED form ("alpha bridge") rather
    // than the stored body ("(b1) bridge"). Exact-substring dedup against
    // b2.body wouldn't catch this; the T8 step 5 leak check must.
    const b1Body = "alpha"
    const b2Body = "(b1) bridge"
    const b1Summary = wrapBlockSummary(1, b1Body)
    const b2Summary = wrapBlockSummary(2, b2Body)
    const blocksById = new Map<number, BlockLike>([
        [1, { summary: b1Summary, refBlockIds: [] }],
        [2, { summary: b2Summary, refBlockIds: [1] }],
    ])
    const consumed: ConsumedBlock[] = [
        { id: 2, summary: b2Summary, schemaVersion: 2 },
    ]
    const modelSummary = "prefix alpha bridge suffix"

    const result = deduplicateBlockContent(modelSummary, consumed, blocksById)

    assert.equal(result.deduped, "prefix (b2) suffix")
    assert.deepEqual(result.refBlockIds, [2])
})

test("extractBlockBody recovers inner body of a wrapped summary", () => {
    const wrapped = wrapBlockSummary(7, "the inner body here")

    const body = extractBlockBody(wrapped, 7)

    assert.equal(body, "the inner body here")
    assert.ok(wrapped.startsWith(COMPRESSED_BLOCK_HEADER), "wrapper must use canonical header")
})

test("stripCompactMarkers strips consumed-block marker tail", () => {
    const input =
        'before (b3) — existing compressed block [topic: "Boot config"] — preserve this token exactly, do not expand or paraphrase after'

    const result = stripCompactMarkers(input)

    assert.equal(result, "before (b3) after")
})

test("stripCompactMarkers strips preserved-block marker tail", () => {
    const input = "x (b5) — preserved compressed block — do not paraphrase or replace y"

    const result = stripCompactMarkers(input)

    assert.equal(result, "x (b5) y")
})

test("stripCompactMarkers strips appendMissingBlockSummaries heading and section refs", () => {
    const input =
        'keep this.\n\nThe following previously compressed summaries were also part of this conversation section:' +
        '\n### (b9)\n(b9) — existing compressed block [topic: "Auth"] — preserve this token exactly, do not expand or paraphrase'

    const result = stripCompactMarkers(input)

    // Heading paragraph dropped; ### heading collapsed to bare (b9); marker
    // tail stripped. Order-of-newlines matters less than the absence of
    // marker text and the presence of a bare (b9).
    assert.ok(!result.includes("existing compressed block"), "marker tail must be stripped")
    assert.ok(!result.includes("The following previously compressed summaries"), "heading must be stripped")
    assert.ok(!result.includes("### "), "section heading must be stripped")
    assert.ok(result.includes("(b9)"), "bare (b9) ref must survive")
    assert.ok(result.startsWith("keep this."), "non-marker prefix must be untouched")
})

test("stripCompactMarkers leaves unrelated (bN) refs alone", () => {
    // A summary that legitimately mentions (b4) in prose (not as part of a
    // marker template) must not be altered. The strip patterns are anchored
    // on the em-dash-led marker tail and the explicit heading strings.
    const input = "see (b4) for the prior context summary"

    const result = stripCompactMarkers(input)

    assert.equal(result, input)
})
