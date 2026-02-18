Your only tool for context management, use it to collapse a range in the conversation into a detailed summary

THE PHILOSOPHY OF COMPRESS
`compress` transforms verbose conversation sequences into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

One method, many safe ranges:

- short, closed ranges for disposable noise
- short, closed ranges for resolved investigative slices
- short, closed ranges for completed implementation chunks

Default to multiple short, bounded compressions. Prefer several safe range compressions over one large sweep whenever independent ranges are available.

CADENCE, SIGNALS, AND LATENCY
Use `compress` during work whenever a slice is summary-safe; do not wait for the user to send another message.

- no fixed threshold forces compression
- prioritize closedness and independence over raw range size
- qualitative signals still matter most (stale exploration, noisy tool bursts, resolved branches)

PREFER smaller, regular compressions OVER infrequent large compressions for better latency and better summary fidelity.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

COMPRESSED BLOCK PLACEHOLDERS
When the selected range includes previously compressed blocks, use this exact placeholder format when referencing one:

- `(bN)`

Compressed block sections in context are clearly marked with a header:

- `[Compressed conversation section]`

Compressed block IDs always use the `bN` form (never `mNNNN`) and are represented in the same XML metadata tag format.

Rules:

- Include every required block placeholder exactly once.
- Do not invent placeholders for blocks outside the selected range.
- Treat `(bN)` placeholders as RESERVED TOKENS. Do not emit `(bN)` text anywhere except intentional placeholders.
- If you need to mention a block in prose, use plain text like `compressed bN` (not as a placeholder).
- Preflight check before finalizing: the set of `(bN)` placeholders in your summary must exactly match the required set, with no duplicates.

These placeholders are semantic references. They will be replaced with the full stored compressed block content when the tool processes your output.

FLOW PRESERVATION WITH PLACEHOLDERS
When you use compressed block placeholders, write the surrounding summary text so it still reads correctly AFTER placeholder expansion.

- Treat each placeholder as a stand-in for a full conversation segment, not as a short label.
- Ensure transitions before and after each placeholder preserve chronology and causality.
- Do not write text that depends on the placeholder staying literal (for example, "as noted in (b2)").
- Your final meaning must be coherent once each placeholder is replaced with its full compressed block content.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

THE WAYS OF COMPRESS
Compress when a range is genuinely closed and the raw conversation has served its purpose:

Research concluded and findings are clear
Implementation finished and verified
Exploration exhausted and patterns understood

Compress smaller ranges when:
You need to discard dead-end noise without waiting for a whole chapter to close
You need to preserve key findings from a narrow slice while freeing context quickly
You can bound a stale range cleanly with injected IDs

Do NOT compress when:
You may need exact code, error messages, or file contents from the range in the immediate next steps
Work in that area is still active or likely to resume immediately
You cannot identify reliable boundaries yet

Before compressing, ask: _"Is this range closed enough to become summary-only right now?"_ Compression is irreversible. The summary replaces everything in the range.

BOUNDARY IDS
You specify boundaries by ID

Use the injected IDs visible in the conversation:

- `mNNNN` IDs identify raw messages
- `bN` IDs identify previously compressed blocks

Rules:

- Pick `startId` and `endId` directly from injected IDs in context.
- IDs must exist in the current visible context.
- `startId` must appear before `endId`.
- Prefer boundaries that produce short, closed ranges.

ID SOURCES

- There is always an ID available for each message in XML tags like `<dcp-message-id>...</dcp-message-id>`.
- Compressed blocks are addressable by `bN` IDs.

Treat `<dcp-message-id>...</dcp-message-id>` as metadata only. It is not part of the tool result semantics.

Do not invent IDs. Use only IDs that are present in context.

PARALLEL COMPRESS EXECUTION
When multiple independent ranges are ready and their boundaries do not overlap, launch MULTIPLE `compress` calls in parallel in a single response. This is the PREFERRED pattern over a single large-range compression when the work can be safely split. Run compression sequentially only when ranges overlap or when a later range depends on the result of an earlier compression.

THE FORMAT OF COMPRESS

```
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: {
    startId: string,       // Boundary ID at range start: mNNNN or bN
    endId: string,         // Boundary ID at range end: mNNNN or bN
    summary: string        // Complete technical summary replacing all content in the range
  }
}
```
