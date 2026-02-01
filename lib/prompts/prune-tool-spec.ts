export const PRUNE_TOOL_SPEC = `Prunes tool outputs from context to manage conversation size and reduce noise.

## IMPORTANT: The Prunable List
A \`<prunable-tools>\` list is provided to you showing available tool outputs you can prune when there are tools available for pruning. Each line has the format \`ID: tool, parameter\` (e.g., \`20: read, /path/to/file.ts\`). You MUST only use numeric IDs that appear in this list to select which tools to prune.

## Quick Examples

\`\`\`javascript
// Example 1: Prune irrelevant file read
prune({
  ids: ["5"]
})
// Context: Read 'wrong_file.ts' which wasn't relevant to the auth system
\`\`\`

\`\`\`javascript
// Example 2: Prune multiple outdated reads in batch
prune({
  ids: ["20", "23", "27"]
})
// Context: Read config.ts three times, keeping only the most recent version
\`\`\`

\`\`\`javascript
// Example 3: Prune irrelevant search results
prune({
  ids: ["15", "16", "17"]
})
// Context: Three grep searches that returned no useful results
\`\`\`

## When to Use This Tool

Use \`prune\` for removing individual tool outputs that are no longer needed:

- **Noise:** Irrelevant, unhelpful, or superseded outputs that provide no value
- **Wrong Files:** You read or accessed something that turned out to be irrelevant
- **Outdated Info:** Outputs that have been superseded by newer information
- **Failed Commands:** Commands that failed and won't be retried

## When NOT to Use This Tool

- **If the output contains useful information:** Keep it in context rather than pruning
- **If you'll need the output later:** Don't prune files you plan to edit or context you'll need for implementation
- **For preserving knowledge:** Use \`distill\` if you want to save key insights before removing
- **For conversation ranges:** Use \`compress\` to collapse multiple messages at once

## Format

- \`ids\` — Array of numeric IDs as strings from the \`<prunable-tools>\` list

## Best Practices

- **Strategic Batching:** Don't prune single small tool outputs (like short bash commands) unless they are pure noise. Wait until you have several items to perform high-impact prunes.
- **Think ahead:** Before pruning, ask: "Will I need this output for upcoming work?" If yes, keep it.
- **Consolidate operations:** Group multiple prunes into a single call when possible. It's rarely worth pruning one tiny tool output.`
