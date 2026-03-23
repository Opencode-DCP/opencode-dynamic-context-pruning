export const COMPRESS_MESSAGE = `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings, tool outcomes, and user intent details that matter... EVERYTHING that preserves the value of the selected message after the raw message is removed.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short user instructions when that best preserves exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool output, and repetition. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages

Each message has an ID inside XML metadata tags like \`<dcp-message-id priority="high">m0007</dcp-message-id>\`.
The ID tag appears at the end of the message it belongs to — it identifies the message above it, not the one below it.
Treat these tags as message metadata only, not as content to summarize. Use only the inner \`mNNNN\` value as the \`messageId\`.
The \`priority\` attribute indicates relative context cost. Prefer higher-priority closed messages before lower-priority ones.
Messages marked as \`<dcp-message-id>BLOCKED</dcp-message-id>\` cannot be compressed.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`mNNNN\`.
- Ignore XML attributes such as \`priority\` when copying the ID; use only the inner \`mNNNN\` value.
- Do NOT use compressed block IDs like \`bN\`.
- Do not invent IDs. Use only IDs that are present in context.
- Do not target prior compressed blocks or block summaries.

BATCHING
Select MANY messages in a single tool call when they are independently safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.
When several messages are equally safe to compress, prefer higher-priority messages first.

Because each message is compressed independently:

- Do not describe ranges
- Do not use start/end boundaries
- Do not use compressed block placeholders
- Do not reference prior compressed blocks with \`(bN)\`
`
