export const ITERATION_NUDGE = `
You've been iterating for a while after the last user message.

If there is a closed block that is unlikely to be referenced immediately, use the compress tool on it now.

Visible message-id tags may include \`priority\` and \`tokens\` metadata. Favor closed blocks with higher priority when choosing what to compress.
Prefer batching multiple short, closed blocks into one compress call when several independent slices are ready.
`
