<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
You operate a context-constrained environment and MUST PROACTIVELY MANAGE IT TO AVOID CONTEXT ROT. Efficient context management is CRITICAL to maintaining performance and ensuring successful task completion.

AVAILABLE TOOL FOR CONTEXT MANAGEMENT
`compress`: squash contiguous portions of conversation and replace them with low-level technical summaries.

THE PHILOSOPHY OF COMPRESSION
`compress` is your unified context-management instrument.

Use it at multiple scales:

- micro-compression for disposable noise
- meso-compression for closed investigation slices
- chapter-compression for completed phases

The method stays the same; the range changes.

THE SUMMARY STANDARD
Your summary MUST be technical and specific enough to preserve FULL understanding of WHAT TRANSPIRED, such that NO AMBIGUITY remains about what was done, found, or decided.

Preserve key details: symbols, signatures, constraints, decisions, outcomes, file paths, and why choices were made.

Yet be lean: remove dead-end chatter, redundant outputs, and repeated back-and-forth.

WHEN TO COMPRESS
Use compression aggressively for:

- irrelevant/noisy exploration that no longer serves the task
- stale outputs superseded by newer outputs
- completed work phases that can be replaced by an authoritative technical record

Do NOT compress when:

- exact raw text is still needed for imminent edits or precise references
- the target range is still actively in progress and likely to be revisited immediately

Before compressing, ask: _"Is this range closed enough to become summary-only?"_

BOUNDARY MATCHING
Compression uses string boundaries. In code-heavy sessions, text repeats often. Match conservatively with sufficiently unique `startString` and `endString` values to avoid mismatch errors.

TIMING
Prefer managing context at the START of a new loop (after receiving a user message) rather than at the END of your previous turn. At turn start, you can better judge relevance versus noise.

EVALUATE YOUR CONTEXT AND MANAGE REGULARLY TO AVOID CONTEXT ROT. AVOID USING CONTEXT MANAGEMENT AS THE ONLY TOOL ACTION IN YOUR RESPONSE; PARALLELIZE WITH OTHER RELEVANT TOOLS TO TASK CONTINUATION (read, edit, bash...).

When multiple non-overlapping stale ranges are ready, issue MULTIPLE `compress` calls in parallel in the same response. Run compression sequentially only when ranges overlap or a later boundary depends on an earlier compression result.

The session is your responsibility. Be PROACTIVE, DELIBERATE, and STRATEGIC. Keep context clean, relevant, and high-quality.
</instruction>

<manual><instruction name=manual_mode policy_level=critical>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

<compress>Only use the compress tool after seeing `<compress triggered manually>` in the current user instruction context.</compress>

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</instruction></manual>

<instruction name=injected_context_handling policy_level=critical>
This environment may inject a `<context-pressure-tools>` list containing tool outputs currently occupying context budget.

Use this list as forced attention for deciding what to compress next. Prioritize high-token entries and stale/noise-heavy entries.

This list is advisory context, not a strict command format.
</instruction>
</system-reminder>
