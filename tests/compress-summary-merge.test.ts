import assert from "node:assert/strict"
import test from "node:test"
import { mergeSubsumedSummaries } from "../lib/tools/compress"
import type { CompressSummary } from "../lib/state"

const PREFIX = "[Compressed conversation block]\n\n"
const WRAP = (name: string, content: string) =>
    `<compress_result name="${name}">\n${content}\n</compress_result>`
const APPEND_NOTICE = (currentSummaryName: string, count: number) => {
    if (count === 1) {
        return `${currentSummaryName} overlapped 1 summary that was not included in the output. It has been appended below:`
    }
    return `${currentSummaryName} overlapped ${count} summaries that were not included in the output. They have been appended below:`
}

test("mergeSubsumedSummaries keeps new summary when there are no prior summaries", () => {
    const merged = mergeSubsumedSummaries([], "Newest summary", "summary_10")
    assert.equal(merged, "Newest summary")
})

test("mergeSubsumedSummaries injects summaries by numeric tag", () => {
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

    const merged = mergeSubsumedSummaries(
        removed,
        "Top\n{summary_0}\nMiddle\n{summary_1}\nBottom",
        "summary_11",
    )

    assert.equal(
        merged,
        `Top\n${WRAP("summary_0", "Older summary A")}\nMiddle\n${WRAP("summary_1", "Older summary B")}\nBottom`,
    )
})

test("mergeSubsumedSummaries matches tags case-insensitively", () => {
    const removed: CompressSummary[] = [
        {
            anchorMessageId: "a1",
            summary: `${PREFIX}Older summary A`,
        },
    ]

    const merged = mergeSubsumedSummaries(removed, "Header\n{sumMary_0}\nFooter", "summary_11")

    assert.equal(merged, `Header\n${WRAP("summary_0", "Older summary A")}\nFooter`)
})

test("mergeSubsumedSummaries uses existing summary names when already wrapped", () => {
    const removed: CompressSummary[] = [
        {
            anchorMessageId: "a1",
            summary: `${PREFIX}${WRAP("summary_4", "Prior block four")}`,
        },
        {
            anchorMessageId: "a2",
            summary: `${PREFIX}${WRAP("summary_9", "Prior block nine")}`,
        },
    ]

    const merged = mergeSubsumedSummaries(
        removed,
        "Use this one: {Summary_9}\nThen later: {SUMMARY_4}",
        "summary_11",
    )

    assert.equal(
        merged,
        `Use this one: ${WRAP("summary_9", "Prior block nine")}\nThen later: ${WRAP("summary_4", "Prior block four")}`,
    )
})

test("mergeSubsumedSummaries appends overlap notice and summaries when no tags are used", () => {
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

    const merged = mergeSubsumedSummaries(removed, "Newest summary", "summary_5")

    assert.equal(
        merged,
        `Newest summary\n\n${APPEND_NOTICE("summary_5", 2)}\n\n${WRAP("summary_0", "Older summary A")}\n\n${WRAP("summary_1", "Older summary B")}`,
    )
})

test("mergeSubsumedSummaries appends unresolved summaries when only some tags are used", () => {
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

    const merged = mergeSubsumedSummaries(removed, "Intro\n{summary_0}\nOutro", "summary_6")

    assert.equal(
        merged,
        `Intro\n${WRAP("summary_0", "Older summary A")}\nOutro\n\n${APPEND_NOTICE("summary_6", 1)}\n\n${WRAP("summary_1", "Older summary B")}`,
    )
})

test("mergeSubsumedSummaries ignores unknown tags and empty summaries", () => {
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

    const merged = mergeSubsumedSummaries(removed, "Start {sumMary_7} End", "summary_3")

    assert.equal(
        merged,
        `Start  End\n\n${APPEND_NOTICE("summary_3", 1)}\n\n${WRAP("summary_0", "Useful prior summary")}`,
    )
})
