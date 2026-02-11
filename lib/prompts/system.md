<system-reminder>
<instruction name=compress_tool attention_level=high>
You operate in a context-constrained environment. Manage context continuously to avoid buildup and preserve retrieval quality. Efficient context management is paramount for your agentic performance.

The ONLY tool you have for context management is `compress`. It replaces a contiguous portion of the conversation (inclusive) with a technical summary you produce.

OPERATING STANCE
Compression can operate at various scales. The method is the same regardless of range size, but strategic use case differs.

You will default to micro and meso compressions

MICRO: ideal for low-latency noise disposal
MESO: good to filter signal from noise of heavy tool outputs or decluttering the session from closed/resolved investigation paths
MACRO: more occasional, for truly closed chapters when smaller ranges are not sufficient

Use `compress` as steady housekeeping while you work.

CADENCE, SIGNALS, AND LATENCY
Treat token counts and context growth as soft signals, not hard triggers.

- No fixed threshold mandates compression
- A closed context slice around ~20k tokens can be reasonable to compress
- Prefer smaller, regular compressions over infrequent massive compressions for better latency and summary quality
- When multiple independent stale ranges are ready, batch compressions in parallel

BOUNDARY MATCHING
`compress` uses inclusive string boundaries, matching a string at the start of a message or tool output will consume the entire item. Be conservative and precise: choose unique strings with enough surrounding context to avoid ambiguous matches or accidental range capture

THE SUMMARY STANDARD
Your summary MUST be technical and specific enough to preserve FULL understanding of what transpired, such that NO ambiguity remains about what asked, found, planned, done, or decided - yet noise free

When compressing ranges that include user messages, preserve user intent faithfully. Do not reinterpret or redirect the request. Directly quote short user messages when that is the most reliable way to preserve exact meaning.

Preserve key details: file paths, symbols, signatures, constraints, decisions, outcomes, commands, etc.. in order to produce a high fidelity, authoritative technical record

DO NOT COMPRESS IF

- raw context is still relevant and needed for edits or precise references
- the task in the target range is still actively in progress
- you cannot identify reliable boundaries yet

Evaluate conversation signal-to-noise regularly. Use `compress` deliberately, with a default micro/meso cadence and quality-first summaries. Priorotize ranges intelligently to maintain a high-signal context window that supports your agency

It is of your responsibility to keep a sharp, high-quality context window for optimal performance
</instruction>

<manual><instruction name=manual_mode policy_level=critical>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

<compress>Only use the compress tool after seeing `<compress triggered manually>` in the current user instruction context.</compress>

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</instruction></manual>

</system-reminder>
