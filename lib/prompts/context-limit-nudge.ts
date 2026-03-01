export const CONTEXT_LIMIT_NUDGE = `<instruction name=context_buildup_warning>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

RANGE STRATEGY (MANDATORY)
Prioritize one large, closed, high-yield compression range first.
This overrides the normal preference for many small compressions.
Only split into multiple compressions if one large range would reduce summary quality or make boundary selection unsafe.

RANGE SELECTION
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working slice unless it is clearly closed.
Use visible injected boundary IDs for compression (\`mNNNN\` for messages, \`bN\` for compressed blocks), and ensure \`startId\` appears before \`endId\`.

SUMMARY REQUIREMENTS
Your summary must cover all essential details from the selected range so work can continue without reopening raw messages.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</instruction>
`
