<system-reminder>
<instruction name=compress_tool attention_level=high>
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is `compress`. It replaces a contiguous portion of the conversation (inclusive) with a technical summary you produce.

OPERATING STANCE
Prefer short, closed, summary-safe ranges.
When multiple independent stale ranges exist, prefer several short compressions (in parallel when possible) over one large-range compression.

Use `compress` as steady housekeeping while you work.

CADENCE, SIGNALS, AND LATENCY

- No fixed threshold mandates compression
- Prioritize closedness and independence over raw range size
- Prefer smaller, regular compressions over infrequent massive compressions for better latency and summary quality
- When multiple independent stale ranges are ready, batch compressions in parallel

BOUNDARY MATCHING
`compress` uses inclusive ID boundaries via `content.startId` and `content.endId`. IDs are injected in context as message refs (`mNNNN`) and compressed block refs (`bN`).

Each message has an ID inside XML metadata tags like `<dcp-message-id>...</dcp-message-id>`.
Treat these tags as boundary metadata only, not as tool result content.

Only choose IDs currently visible in context. Do not invent IDs.

RESPECT THE CHRONOLOGY OF THE RANGE
`content.startId` MUST refer to an item above/before `content.endId`
`content.endId` MUST refer to an item below/after `content.startId`
Always provide boundaries via the tool schema fields `content.startId` and `content.endId`.

THE SUMMARY STANDARD
Your summary MUST be technical and specific enough to preserve FULL understanding of what transpired, such that NO ambiguity remains about what asked, found, planned, done, or decided - yet noise free

When compressing ranges that include user messages, preserve user intent faithfully. Do not reinterpret or redirect the request. Directly quote short user messages when that is the most reliable way to preserve exact meaning.

Preserve key details: file paths, symbols, signatures, constraints, decisions, outcomes, commands, etc.. in order to produce a high fidelity, authoritative technical record

DO NOT COMPRESS IF

- raw context is still relevant and needed for edits or precise references
- the task in the target range is still actively in progress

Evaluate conversation signal-to-noise REGULARLY. Use `compress` deliberately with quality-first summaries. Prefer multiple short, independent range compressions before considering broader ranges, and prioritize ranges intelligently to maintain a high-signal context window that supports your agency

It is of your responsibility to keep a sharp, high-quality context window for optimal performance
</instruction>

<manual><instruction name=manual_mode policy_level=critical>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing `<compress triggered manually>` in the current user instruction context.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</instruction></manual>

</system-reminder>
