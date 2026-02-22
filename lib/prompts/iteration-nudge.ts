export const ITERATION_NUDGE = `<instruction name=iteration_nudge>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), compress it now.

Prefer multiple short, closed ranges over one large range when several independent slices are ready.
</instruction>
`
