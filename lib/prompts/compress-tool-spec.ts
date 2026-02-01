export const COMPRESS_TOOL_SPEC = `Collapses a contiguous range of conversation into a single summary.

## When to Use This Tool

Use \`compress\` when you want to condense an entire sequence of work into a brief summary:

- **Phase Completion:** You completed a phase (research, tool calls, implementation) and want to collapse the entire sequence into a summary.
- **Exploration Done:** You explored multiple files or ran multiple commands and only need a summary of what you learned.
- **Failed Attempts:** You tried several unsuccessful approaches and want to condense them into a brief note.
- **Verbose Output:** A section of conversation has grown large but can be summarized without losing critical details.

## When NOT to Use This Tool

- **If you need specific details:** If you'll need exact code, file contents, or error messages from the range, keep them.
- **For individual tool outputs:** Use \`prune\` or \`distill\` for single tool outputs. Compress targets conversation ranges.
- **If it's recent content:** You may still need recent work for the current phase.

## How It Works

1. \`startString\` — A unique text string that marks the start of the range to compress
2. \`endString\` — A unique text string that marks the end of the range to compress
3. \`topic\` — A short label (3-5 words) describing the compressed content
4. \`summary\` — The replacement text that will be inserted

Everything between startString and endString (inclusive) is removed and replaced with your summary.

**Important:** The compress will FAIL if \`startString\` or \`endString\` is not found in the conversation. The compress will also FAIL if either string is found multiple times. Provide a larger string with more surrounding context to uniquely identify the intended match.

## Best Practices
- **Choose unique strings:** Pick text that appears only once in the conversation.
- **Write concise topics:** Examples: "Auth System Exploration", "Token Logic Refactor"
- **Write comprehensive summaries:** Include key information like file names, function signatures, and important findings.
- **Timing:** Best used after finishing a work phase, not during active exploration.

## Format

- \`input\`: Array with four elements: [startString, endString, topic, summary]

## Example

<example_compress>
Conversation: [Asked about auth] -> [Read 5 files] -> [Analyzed patterns] -> [Found "JWT tokens with 24h expiry"]

[Uses compress with:
  input: [
    "Asked about authentication",
    "JWT tokens with 24h expiry",
    "Auth System Exploration",
    "Auth: JWT 24h expiry, bcrypt passwords, refresh rotation. Files: auth.ts, tokens.ts, middleware/auth.ts"
  ]
]
</example_compress>

<example_keep>
Assistant: [Just finished reading auth.ts]
I've read the auth file and now need to make edits based on it. I'm keeping this in context rather than compressing.
</example_keep>`
