Use this tool to collapse a contiguous range of conversation into a preserved summary.

THE PHILOSOPHY OF COMPRESS
`compress` transforms verbose conversation sequences into dense, high-fidelity summaries. This is not cleanup - it is crystallization. Your summary becomes the authoritative record of what transpired.

Think of compression as phase transitions: raw exploration becomes refined understanding. The original context served its purpose; your summary now carries that understanding forward.

One method, many scales:

- micro-range compression for disposable noise
- focused compression for closed investigative slices
- chapter compression for completed implementation phases

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

THE WAYS OF COMPRESS
Compress when a chapter closes - when a phase of work is truly complete and the raw conversation has served its purpose:

Research concluded and findings are clear
Implementation finished and verified
Exploration exhausted and patterns understood

Compress smaller ranges when:
You need to discard dead-end noise without waiting for a whole chapter to close
You need to preserve key findings from a narrow slice while freeing context quickly
You can bound a stale range cleanly with unique boundaries

Do NOT compress when:
You may need exact code, error messages, or file contents from the range in the immediate next steps
Work in that area is still active or likely to resume immediately
You cannot identify reliable boundaries yet

Before compressing, ask: _"Is this range closed enough to become summary-only?"_ Compression is irreversible. The summary replaces everything in the range.

BOUNDARY MATCHING
You specify boundaries by matching unique text strings in the conversation. CRITICAL: In code-centric conversations, strings repeat often. Provide sufficiently unique text to match exactly once. If a match fails (not found or found multiple times), the tool will error - extend your boundary string with more surrounding context in order to make SURE the tool does NOT error.

WHERE TO PICK STRINGS FROM (important for reliable matching):

- Your own assistant text responses (MOST RELIABLE - always stored verbatim)
- The user's own words in their messages
- Tool result output text (distinctive substrings within the output)
- Previous compress summaries
- Tool input string values (individual values, not whole serialized objects)

WHERE TO NEVER PICK STRINGS FROM:

- `<system-reminder>` tags or any XML wrapper/meta-commentary around messages
- Injected system instructions (plan mode text, max-steps warnings, mode-switch text, environment info)
- File/directory listing framing text (e.g. "Called the Read tool with the following input...")
- Strings that span across message or part boundaries
- Entire serialized JSON objects (key ordering may differ - pick a distinctive substring within instead)

THE FORMAT OF COMPRESS
`topic`: Short label (3-5 words) for display - e.g., "Auth System Exploration"
`content`: Object containing:
`startString`: Unique text string marking the beginning of the range
`endString`: Unique text string marking the end of the range
`summary`: Complete technical summary replacing all content in the range
