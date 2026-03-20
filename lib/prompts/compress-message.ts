export const COMPRESS_MESSAGE = `Collapse selected individual messages in the conversation into detailed summaries.

THE PHILOSOPHY OF MESSAGE COMPRESS
\`compress\` in message mode transforms specific stale messages into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what each selected message contributed.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original message served its purpose; your summary now carries that understanding forward.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings, tool outcomes, and user intent details that matter... EVERYTHING that preserves the value of the selected message after the raw message is removed.

USER INTENT FIDELITY
When a selected message contains user intent, preserve that intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote short user instructions when that best preserves exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool output, and repetition. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`mNNNN\` IDs identify raw messages

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
Treat these tags as message metadata only, not as content to summarize.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`mNNNN\`.
- Do NOT use compressed block IDs like \`bN\`.
- Do not invent IDs. Use only IDs that are present in context.
- Do not target prior compressed blocks or block summaries.

THE WAYS OF MESSAGE COMPRESS
Compress when an individual message is genuinely closed and unlikely to be needed verbatim again:

Research findings have already been absorbed into later work
Tool-heavy assistant updates are no longer needed in raw form
Earlier planning or analysis messages are now stale but still important to retain as summary

Do NOT compress when:
You may need the exact raw message text, code, or error output in the immediate next steps
The message is still actively being referenced or edited against
The target is a prior compressed block or block summary rather than a raw message

Before compressing, ask: _"Is this message closed enough to become summary-only right now?"_

BATCHING
Do not call the tool once per message. Select MANY messages in a single tool call when they are independently safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.

Because each message is compressed independently:

- Do not describe ranges
- Do not use start/end boundaries
- Do not use compressed block placeholders
- Do not reference prior compressed blocks with \`(bN)\`
`
