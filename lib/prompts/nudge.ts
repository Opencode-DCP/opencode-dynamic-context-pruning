export const CONTEXT_LIMIT_NUDGE = `<instruction name=context_buildup_warning>
CRITICAL WARNING: CONTEXT BUILD-UP

The context window is filling-up. You've reached a point where performance may increasingly degrade. Active context management is now strategically relevant. Mind your context footprint as the conversation grows

YOU MUST USE THE COMPRESS TOOL NOW TO AVOID CONTEXT ROT. THIS IS CRITICAL. Do not delay context management any further.

DOOOOO IT!!!

Avoid unnecessary context build-up with targeted uses of the \`compress\` tool. Start with low hanging fruits and clearly identified ranges that can be compressed with minimal risk of losing critical information. Look BACK on the conversation history and avoid compressing the newest ranges until you have exhausted older ones

RANGE STRATEGY (MANDATORY)
Prefer multiple short, closed range compressions.
When multiple independent stale ranges are ready, batch those short compressions in parallel.
Do not jump to a single broad range when the same cleanup can be done safely with several bounded ranges.

If you are performing a critical atomic operation, do not interrupt it, but make sure to perform context management rapidly

Use injected boundary IDs for compression (\`mNNNN\` for messages, \`bN\` for compressed blocks). Pick IDs that are visible in context and ensure \`startId\` appears before \`endId\`.

Ensure your summaries are inclusive of all parts of the range.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</instruction>
`
