export const TURN_NUDGE = `
Evaluate the conversation for compressible blocks.

If any block is cleanly closed and unlikely to be needed again, use the compress tool on it.
If direction has shifted, compress earlier blocks that are now less relevant.

Visible message-id tags may include \`priority\` and \`tokens\` metadata. Favor closed blocks with higher priority when choosing what to compress.
Prefer batching several small, closed block compressions into one compress call when they are independent.
Use visible raw block-scoped message IDs like \`b12m0042\` as \`content[].targetId\` entries when selecting blocks.
`
