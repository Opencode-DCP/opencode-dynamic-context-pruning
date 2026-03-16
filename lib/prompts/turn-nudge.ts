export const TURN_NUDGE = `
Evaluate the conversation for compressible blocks.

If any block is cleanly closed and unlikely to be needed again, use the compress tool on it.
If direction has shifted, compress earlier blocks that are now less relevant.

Prefer small, closed block compressions over one broad compression.
Use a visible raw block-scoped message ID like \`b12m0042\` as \`targetId\` when selecting a block.
`
