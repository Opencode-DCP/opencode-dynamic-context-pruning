export const USER_TURN_NUDGE = `<instruction name=turn_nudge>
Review the user request above against the work that just finished.

If this request shifts direction, use the compress tool on earlier ranges that are now less relevant.
If any range is cleanly closed and not needed to answer this request, compress it.
If you determine a compression of previous content makes sense, do so first before completing the request above.

Prefer small, closed-range compressions over one broad compression.
Keep active context needed for this request uncompressed.
</instruction>
`

export const ASSISTANT_TURN_NUDGE = `<instruction name=turn_nudge>
Agentic loop completed. Evaluate the just-finished portion against the next user message.

At this stage, prefer one or more small, closed-range compressions over one broad compression.
The goal is not to nuke current context. The goal is to filter identified noise and distill key information so context accumulation stays under control.

If a portion is closed and unlikely to be needed again, use the compress tool on it.
If a portion is still active or likely to be referenced immediately, keep it uncompressed for now.
</instruction>
`
