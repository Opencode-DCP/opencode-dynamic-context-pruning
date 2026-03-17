export const CONTEXT_LIMIT_NUDGE = `
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

BLOCK STRATEGY (MANDATORY)
Prioritize one high-yield compress call first.
Batch several closed blocks into that call when they are independent and summary quality stays high.
Only fall back to a single block if batching would reduce summary quality or make selection unsafe.

BLOCK SELECTION
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working block unless it is clearly closed.
Visible message-id tags may include \`priority\` and \`tokens\` metadata. Favor closed blocks with higher priority when choosing what to compress.
Use visible injected block IDs for compression. Prefer raw block-scoped message IDs like \`b12m0042\` as \`content[].targetId\` entries.

SUMMARY REQUIREMENTS
Your summary must cover all essential details from the selected block so work can continue without reopening raw messages.
If the compressed block includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
`
