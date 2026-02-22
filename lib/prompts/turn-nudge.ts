export const TURN_NUDGE = `<instruction name=post_loop_turn_nudge>
Agentic loop completed. Evaluate the just-finished portion against the next user message.

At this stage, prefer one or more small, closed-range compressions over one broad compression.
The goal is not to nuke current context. The goal is to filter identified noise and distill key information so context accumulation stays under control.

If a portion is closed and unlikely to be needed again, compress it.
If a portion is still active or likely to be referenced immediately, keep it uncompressed for now.
</instruction>
`
