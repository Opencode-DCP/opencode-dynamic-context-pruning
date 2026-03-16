export const COMPRESS = `Collapse a single conversation block into a detailed summary.

THE PHILOSOPHY OF COMPRESS
\`compress\` transforms verbose conversation sequences into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed block includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

COMPRESSED BLOCK PLACEHOLDERS
When the selected block includes previously compressed blocks, use this exact placeholder format when referencing one:

- \`(bN)\`

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Compressed block IDs always use the \`bN\` form (never \`mNNNN\`) and are represented in the same XML metadata tag format.

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected block.
- Treat \`(bN)\` placeholders as RESERVED TOKENS. Do not emit \`(bN)\` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (not as a placeholder).
- Preflight check before finalizing: the set of \`(bN)\` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

TARGETING RAW BLOCKS
Visible raw messages use block-scoped IDs like \`b12m0042\`.

- The \`b12\` portion identifies the block.
- The \`m0042\` portion identifies a visible message within that block.
- Passing any visible \`bNmNNNN\` message ID as \`targetId\` compresses the ENTIRE raw block \`bN\`.
- Do not try to select partial slices within a block. This tool compresses whole blocks only.
- Prefer choosing a visible raw message ID from the block you want to compress.
- A bare \`bN\` may refer to an already compressed block in conversation history; use it as a placeholder reference when needed, not as the normal way to target fresh raw conversation.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in \`(b2)\`").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

THE WAYS OF COMPRESS
Compress when a block is genuinely closed and the raw conversation in that block has served its purpose:

Research concluded and findings are clear
Implementation finished and verified
Exploration exhausted and patterns understood

Compress blocks when:
You need to discard dead-end noise without waiting for a whole chapter to close
You need to preserve key findings from a completed slice while freeing context quickly
The visible block is stale, self-contained, and unlikely to be reopened soon

Do NOT compress when:
You may need exact code, error messages, or file contents from the block in the immediate next steps
Work in that block is still active or likely to resume immediately
You cannot identify a reliable target block yet

Before compressing, ask: _"Is this block closed enough to become summary-only right now?"_ Compression is irreversible. The summary replaces everything in the block.

BLOCK IDS
You specify a single block target by ID using the injected IDs visible in the conversation:

- \`bNmNNNN\` IDs identify raw messages inside block \`bN\`
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
Treat these tags as block metadata only, not as tool result content.

Rules:

- Pick \`targetId\` directly from an injected ID in context.
- IDs must exist in the current visible context.
- Prefer raw block-scoped message IDs like \`b12m0123\` when choosing a block to compress.
- A \`targetId\` must identify exactly one block worth of raw messages.
- Do not invent IDs. Use only IDs that are present in context.

PARALLEL COMPRESS EXECUTION
When multiple independent blocks are ready, launch MULTIPLE \`compress\` calls in parallel in a single response. This is the PREFERRED pattern over a single broad compression when the work can be safely split. Run compression sequentially only when a later block depends on the result of an earlier compression.
`
