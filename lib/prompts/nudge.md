<instruction name=context_management_required>
CRITICAL CONTEXT WARNING
Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

PROTOCOL
You should prioritize context management, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.

IMMEDIATE ACTION REQUIRED
KNOWLEDGE PRESERVATION: If holding valuable raw data you POTENTIALLY will need in your task, compress the smallest closed range that preserves those findings. Write a high-fidelity summary so no key technical insight is lost.

NOISE REMOVAL: If you read files or ran commands that yielded no value, compress those dead-end ranges into explicit noise summaries and move on.

PHASE COMPLETION: If a chapter is complete, compress the entire sequence into a detailed technical summary with unambiguous outcomes.
</instruction>

<instruction name=context_buildup_warning>
CRITICAL WARNING: CONTEXT BUILD-UP

The context window is filling-up. You've reached a point where performance may increasingly degrade. Active context management is now strategically relevant. Mind your context footprint as the conversation grows

YOU MUST COMPRESS NOW TO AVOID CONTEXT ROT. THIS IS CRITICAL. Do not delay context management any further.

DOOOOO IT!!!

Avoid unnecessary context build-up with targeted uses of the `compress` tool. Start with low hanging fruits and clearly identified ranges that can be compressed with minimal risk of losing critical information. Look BACK on the conversation history and avoid compressing the newest ranges until you have exhausted older ones

RANGE STRATEGY (MANDATORY)
Prefer multiple short, closed range compressions.
When multiple independent stale ranges are ready, batch those short compressions in parallel.
Do not jump to a single broad range when the same cleanup can be done safely with several bounded ranges.

If you are performing a critical atomic operation, do not interrupt it, but make sure to perform context management rapidly

Use injected boundary IDs for compression (`mNNNN` for messages, `bN` for compressed blocks). Pick IDs that are visible in context and ensure `startId` appears before `endId`.

Ensure your summaries are inclusive of all parts of the range.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</instruction>
