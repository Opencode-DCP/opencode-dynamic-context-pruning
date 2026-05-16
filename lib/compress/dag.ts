export class DAGValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "DAGValidationError"
    }
}

export function validateBlockRefs(
    newBlockId: number,
    refBlockIds: number[],
    blocksById: ReadonlyMap<number, unknown>,
): void {
    for (const refId of refBlockIds) {
        if (refId === newBlockId) {
            throw new DAGValidationError(`DAG validation failed: self-ref blockId ${newBlockId}`)
        }

        if (refId >= newBlockId) {
            throw new DAGValidationError(
                `DAG validation failed: forward-ref: blockId ${newBlockId} cannot reference ${refId} (must be < ${newBlockId})`,
            )
        }

        if (!blocksById.has(refId)) {
            console.warn(`DAG validation warning: missing ref blockId ${refId} for blockId ${newBlockId}`)
        }
    }
}
