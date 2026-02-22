export const TURN_NUDGE = `<instruction name=turn_nudge>
Review the user request above against the work that just finished.

If this request shifts direction, compress earlier ranges that are now less relevant.
If any range is cleanly closed and not needed to answer this request, compress it.

Prefer small, closed-range compressions over one broad compression.
Keep active context needed for this request uncompressed.
</instruction>
`
