import assert from "node:assert/strict"
import test from "node:test"
import { mergeSubsumedSummaries } from "../lib/tools/compress"
import type { CompressSummary } from "../lib/state"

const PREFIX = "[Compressed conversation block]\n\n"

test("mergeSubsumedSummaries keeps new summary when there are no prior summaries", () => {
    const merged = mergeSubsumedSummaries([], "Newest summary")
    assert.equal(merged, "Newest summary")
})

test("mergeSubsumedSummaries prepends subsumed summaries in order", () => {
    const removed: CompressSummary[] = [
        {
            anchorMessageId: "a1",
            summary: `${PREFIX}Older summary A`,
        },
        {
            anchorMessageId: "a2",
            summary: `${PREFIX}Older summary B`,
        },
    ]

    const merged = mergeSubsumedSummaries(removed, "Newest summary")

    assert.equal(merged, "Older summary A\n\nOlder summary B\n\nNewest summary")
})

test("mergeSubsumedSummaries ignores empty subsumed summaries", () => {
    const removed: CompressSummary[] = [
        {
            anchorMessageId: "a1",
            summary: `${PREFIX}   `,
        },
        {
            anchorMessageId: "a2",
            summary: "Useful prior summary",
        },
    ]

    const merged = mergeSubsumedSummaries(removed, "Newest summary")

    assert.equal(merged, "Useful prior summary\n\nNewest summary")
})
