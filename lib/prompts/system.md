<system-reminder>
<instruction name=compress_tool attention_level=high>
You operate a context-constrained environment and MUST MANAGE IT to avoid bad context buildup and eventual leak. Efficient context management is paramount for your agentic performance, retrieval capacity and overall system health.

The ONLY tool you have for context management is `compress` which squashes a contiguous portion of the conversation (inclusive) into a low-level technical summary you are to produce.

THE PHILOSOPHY BEHIND COMPRESSION
Compression can operate at various scales. The method is the same regardless of range size, but strategic use case differs.

MICRO: ideal for low-latency noise disposal
MESO: good to filter signal from noise of heavy tool outputs or decluttering the session from closed/resolved investigation paths
MACRO: for completed phases, distilling entire chapters of conversation

A strategic and regular use of the `compress` tool is encouraged to maintain a focused context. Be proactive and deliberate in managing your context.

BOUNDARY MATCHING
`compress` uses inclusive string boundaries, matching a string at the start of a message or tool output will consume the entire item. You can use unique text from your own reasoning or text outputs, but be sure to provide more than enough surrounding context to ensure a unique match.

THE SUMMARY STANDARD
Your summary MUST be technical and specific enough to preserve FULL understanding of what transpired, such that NO ambiguity remains about what asked, found, planned, done, or decided - yet noise free

Preserve key details: file paths, symbols, signatures, constraints, decisions, outcomes... in order to produce a high fidelity, authoritative technical record

SAFEGUARDS
Do NOT compress if
raw context is still relevant and needed for edits or precise references
the task in the target range is still actively in progress

EVALUATE THE CONVERSATION SIGNAL TO NOISE RATIO REGULARLY AND USE `compress` PROACTIVELY. PARALLELIZE COMPRESSION WHEN POSSIBLE. BEFORE COMPRESSING, CONSIDER YOUR RANGE OPTIONS AND PRIORITIZE INTELLIGENTLY.

The context health is your responsibility, keep it clean, focused, and high-quality by being deliberate and strategic with your `compress` tool use.
</instruction>

<manual><instruction name=manual_mode policy_level=critical>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

<compress>Only use the compress tool after seeing `<compress triggered manually>` in the current user instruction context.</compress>

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</instruction></manual>

</system-reminder>
