import {
    formatBlockPlaceholder,
    formatBlockRef,
    formatMessageIdTag,
} from "../message-ids"
import type { BlockLike } from "./renderer"

export const COMPRESSED_BLOCK_HEADER = "[Compressed conversation section]"

export interface ConsumedBlock {
    id: number
    summary: string
    schemaVersion?: number
}

export interface DedupResult {
    deduped: string
    refBlockIds: number[]
}

/**
 * Strip the standard [Compressed conversation section] header prefix and
 * dcp-message-id `bN` boundary footer from a stored block.summary,
 * returning the trimmed inner body. Returns "" when the summary contains no
 * body content.
 *
 * Mirrors the inverse of wrapBlockSummary in lib/compress/state.ts and is the
 * canonical way to recover the raw model-produced summary text for matching.
 */
export function extractBlockBody(blockSummary: string, blockId: number): string {
    const header = COMPRESSED_BLOCK_HEADER
    const footer = formatMessageIdTag(formatBlockRef(blockId))
    let body = blockSummary
    if (body.startsWith(`${header}\n`)) {
        body = body.slice(header.length + 1)
    } else if (body.startsWith(header)) {
        body = body.slice(header.length)
    }
    if (body.endsWith(footer)) {
        body = body.slice(0, -footer.length)
    }
    return body.trim()
}

/**
 * Strip compact marker text that the LLM may have parroted from the
 * compression prompt. Markers are injected into the prompt by
 * `appendMissingBlockSummaries` and `injectBlockPlaceholders` in
 * `lib/compress/range-utils.ts` to instruct the model to leave (bN) refs
 * verbatim; if the model echoes the marker text into its returned summary we
 * must remove the surrounding instruction text before persisting so stored
 * block summaries contain only bare `(bN)` refs (Oracle Round 3 gap 1:
 * storage vs prompt separation).
 *
 * Patterns stripped:
 *   - `(bN) — existing compressed block [topic: "..."] — preserve this token
 *     exactly, do not expand or paraphrase`  →  `(bN)`
 *   - `(bN) — preserved compressed block — do not paraphrase or replace`
 *     →  `(bN)`
 *   - `### (bN)` heading lines  →  `(bN)`
 *   - `The following previously compressed summaries were also part of this
 *     conversation section:` heading paragraph (dropped entirely)
 *
 * Marker text uses real em-dashes (—) so plain ASCII summaries are never
 * affected. Each pattern is anchored on the literal English used by
 * range-utils.ts; the stripping is intentionally narrow to avoid clobbering
 * legitimate summary text that happens to mention (bN).
 */
export function stripCompactMarkers(text: string): string {
    let result = text

    // Tail 1: consumed-block marker (existing compressed block).
    result = result.replace(
        /\(b(\d+)\)\s*—\s*existing compressed block\s+\[topic:\s*"[^"]*"\]\s*—\s*preserve this token exactly,?\s*do not expand or paraphrase/g,
        "(b$1)",
    )

    // Tail 2: preserved-block marker (still-active compressed block).
    result = result.replace(
        /\(b(\d+)\)\s*—\s*preserved compressed block\s*—\s*do not paraphrase or replace/g,
        "(b$1)",
    )

    // Per-block heading lines from appendMissingBlockSummaries (run before
    // the section-heading paragraph strip so the leading `\n` is preserved
    // for the `\n###` anchor).
    result = result.replace(/(?:^|\n)###\s+\(b(\d+)\)\s*/g, "\n(b$1)")

    // Section heading from appendMissingBlockSummaries. `[ \t]*` (not `\s*`)
    // so newlines after the colon stay intact for adjacent strips.
    result = result.replace(
        /\n*The following previously compressed summaries were also part of this conversation section:[ \t]*/g,
        "",
    )

    return result
}

/**
 * Replace verbatim occurrences of consumed block bodies in the model-produced
 * summary with `(bN)` placeholders so the stored summary stays compact.
 *
 * Algorithm:
 *   1. Extract the inner body of every consumed block via extractBlockBody
 *      (strips the header/footer wrapper so we match the raw model text).
 *   2. Sort by body length DESCENDING so a short body that happens to be a
 *      substring of a longer body cannot pre-empt the longer match.
 *   3. For each body, String.replace(body, "(bN)") substitutes the FIRST
 *      occurrence only. Each consumed block is replaced at most once and
 *      only enters refBlockIds when its body actually matched.
 *   4. T8 step 5: rendered-content leak detection. After the exact-substring
 *      pass, walk a body-only DAG expansion of each not-yet-matched consumed
 *      block (renderBodyOnly) and check whether its FULL recursive body
 *      appears verbatim in the working summary. If so, log a warning and
 *      replace with (bN) — this catches snowball cases where the model copied
 *      the full rendered chain rather than the compact stored body.
 *
 * Returns { deduped, refBlockIds } where refBlockIds is the list of blocks
 * whose body or rendered expansion was actually replaced, in replacement
 * order.
 */
export function deduplicateBlockContent(
    modelSummary: string,
    consumedBlocks: ReadonlyArray<ConsumedBlock>,
    blocksById: ReadonlyMap<number, BlockLike>,
): DedupResult {
    const consumedBodies: Array<{ id: number; body: string }> = []
    for (const consumed of consumedBlocks) {
        const body = extractBlockBody(consumed.summary, consumed.id)
        if (body.length === 0) {
            continue
        }
        consumedBodies.push({ id: consumed.id, body })
    }
    consumedBodies.sort((left, right) => right.body.length - left.body.length)

    let working = modelSummary
    const refBlockIds: number[] = []
    const replacedIds = new Set<number>()
    for (const { id, body } of consumedBodies) {
        if (working.indexOf(body) === -1) {
            continue
        }
        working = working.replace(body, formatBlockPlaceholder(id))
        refBlockIds.push(id)
        replacedIds.add(id)
    }

    // T8 step 5: rendered-content leak detection. For each consumed block not
    // already matched by exact-substring dedup, recursively expand its body's
    // (bN) refs against blocksById and check whether the FULLY EXPANDED BODY
    // appears verbatim in `working`. This catches snowball cases where the
    // model paraphrased the consumed body's structure but kept all the child
    // content inline (e.g. body "(b1) bridge" with b1 = "alpha" leaking as
    // "alpha bridge" — exact-substring dedup against the literal body would
    // not match, but the renderer-equivalent expansion does).
    //
    // We expand at the BODY level (not the wrapped renderBlockForContext
    // output) because the model never sees the [Compressed conversation
    // section] wrapper in its summary; the wrapped form would have nested
    // headers/footers spliced into it and would not match raw model text.
    const memo = new Map<number, string>()
    for (const consumed of consumedBlocks) {
        if (replacedIds.has(consumed.id)) {
            continue
        }
        const rendered = renderBodyOnly(consumed.id, blocksById, memo, new Set<number>())
        if (rendered.length === 0) {
            continue
        }
        // Avoid trivially-matching when rendered === body (already attempted
        // by the exact-substring pass above).
        const body = extractBlockBody(consumed.summary, consumed.id)
        if (rendered === body) {
            continue
        }
        if (working.indexOf(rendered) === -1) {
            continue
        }
        console.warn(
            `wrapCompressedSummary: rendered-content leak detected for (b${consumed.id}); replacing with bare ref`,
        )
        working = working.replace(rendered, formatBlockPlaceholder(consumed.id))
        refBlockIds.push(consumed.id)
        replacedIds.add(consumed.id)
    }

    return { deduped: working, refBlockIds }
}

/**
 * Recursively expand a block's BODY (no wrapper, no headers/footers) by
 * replacing each `(bN)` placeholder with its child's body. Used by
 * deduplicateBlockContent for the rendered-content leak check.
 *
 * Differs from renderBlockForContext in two ways:
 *   1. Operates on extractBlockBody output (no wrapper) at every level so
 *      the final string is a clean concatenation of bare bodies.
 *   2. Uses a per-call memo to avoid re-expanding shared subtrees in a
 *      diamond DAG. The renderer's `renderedOnce` set instead emits an
 *      [already expanded above] marker, which would not match raw model
 *      text and is the wrong semantics here.
 *
 * `expanding` mirrors the renderer's cycle detector: if a forward-ref or a
 * cycle slipped past T4's validation we return the literal `(bN)` token
 * rather than recurse infinitely.
 */
function renderBodyOnly(
    blockId: number,
    blocksById: ReadonlyMap<number, BlockLike>,
    memo: Map<number, string>,
    expanding: Set<number>,
): string {
    const cached = memo.get(blockId)
    if (cached !== undefined) {
        return cached
    }
    if (expanding.has(blockId)) {
        return formatBlockPlaceholder(blockId)
    }
    const block = blocksById.get(blockId)
    if (!block) {
        return formatBlockPlaceholder(blockId)
    }

    const body = extractBlockBody(block.summary, blockId)
    // Legacy v1 block: body has no DAG refs to expand.
    if (block.refBlockIds === undefined) {
        memo.set(blockId, body)
        return body
    }

    expanding.add(blockId)
    let result = body
    const seen = new Set<number>()
    try {
        // Walk every (bN) the body actually contains so cross-refs not listed
        // in refBlockIds (legacy migration noise) still expand correctly.
        const matches = body.matchAll(/\(b(\d+)\)/g)
        for (const match of matches) {
            const refId = Number.parseInt(match[1], 10)
            if (!Number.isInteger(refId) || seen.has(refId)) {
                continue
            }
            seen.add(refId)
            const childText = renderBodyOnly(refId, blocksById, memo, expanding)
            result = result.split(formatBlockPlaceholder(refId)).join(childText)
        }
    } finally {
        expanding.delete(blockId)
    }
    memo.set(blockId, result)
    return result
}
