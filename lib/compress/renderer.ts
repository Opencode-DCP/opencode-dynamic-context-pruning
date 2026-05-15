import { extractBlockPlaceholders, formatBlockPlaceholder } from "../message-ids"
import { countTokens } from "../token-utils"

export class CycleError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "CycleError"
    }
}

export type BlockLike = {
    summary: string
    refBlockIds?: number[]
    schemaVersion?: number
}

export interface RenderContext {
    expanding: Set<number>
    renderedOnce: Set<number>
}

export function renderBlockForContext(
    blockId: number,
    blocksById: Map<number, BlockLike> | ReadonlyMap<number, BlockLike>,
    ctx?: RenderContext,
): { text: string; renderedTokens: number } {
    const isTopLevel = ctx === undefined
    const renderCtx: RenderContext = ctx ?? {
        expanding: new Set<number>(),
        renderedOnce: new Set<number>(),
    }

    const text = renderInner(blockId, blocksById, renderCtx)

    return {
        text,
        renderedTokens: isTopLevel ? countTokens(text) : 0,
    }
}

function renderInner(
    blockId: number,
    blocksById: Map<number, BlockLike> | ReadonlyMap<number, BlockLike>,
    ctx: RenderContext,
): string {
    // Diamond dedup: a block that has already been fully expanded earlier in this
    // top-level render is collapsed to a marker so its content is not duplicated.
    if (ctx.renderedOnce.has(blockId)) {
        return `${formatBlockPlaceholder(blockId)} [already expanded above]`
    }

    // Cycle detection: a block currently on the expansion call stack means the
    // DAG contains a true cycle. Forward-ref validation (T4) should prevent this
    // at write time; throwing here is defensive against data corruption.
    if (ctx.expanding.has(blockId)) {
        throw new CycleError(
            `Cycle detected in compression block DAG at blockId ${blockId}`,
        )
    }

    const block = blocksById.get(blockId)
    if (!block) {
        return `${formatBlockPlaceholder(blockId)} [not found]`
    }

    // Legacy v1 block: no DAG refs to expand, summary is returned verbatim.
    if (block.refBlockIds === undefined) {
        ctx.renderedOnce.add(blockId)
        return block.summary
    }

    ctx.expanding.add(blockId)
    try {
        let result = block.summary
        const placeholderIds = extractBlockPlaceholders(block.summary)
        const seen = new Set<number>()
        for (const refId of placeholderIds) {
            if (seen.has(refId)) {
                continue
            }
            seen.add(refId)
            const childText = renderInner(refId, blocksById, ctx)
            const placeholder = formatBlockPlaceholder(refId)
            result = result.split(placeholder).join(childText)
        }
        return result
    } finally {
        ctx.expanding.delete(blockId)
        ctx.renderedOnce.add(blockId)
    }
}
