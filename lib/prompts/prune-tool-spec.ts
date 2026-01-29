export const PRUNE_TOOL_SPEC = `Prunes tool outputs from context to manage conversation size and reduce noise.

## IMPORTANT: The Prunable List
A \`<prunable-tools>\` list is provided to you showing available tool outputs you can prune when there are tools available for pruning. Each line has the format \`ID: tool, parameter\` (e.g., \`20: read, /path/to/file.ts\`). You MUST only use numeric IDs that appear in this list to select which tools to prune.

## When to Use This Tool

Use \`prune\` for removing individual tool outputs that are no longer needed:

- **Noise:** Irrelevant, unhelpful, or superseded outputs that provide no value.
- **Wrong Files:** You read or accessed something that turned out to be irrelevant.
- **Outdated Info:** Outputs that have been superseded by newer information.

## When NOT to Use This Tool

- **If the output contains useful information:** Keep it in context rather than pruning.
- **If you'll need the output later:** Don't prune files you plan to edit or context you'll need for implementation.

## Best Practices
- **Strategic Batching:** Don't prune single small tool outputs (like short bash commands) unless they are pure noise. Wait until you have several items to perform high-impact prunes.
- **Think ahead:** Before pruning, ask: "Will I need this output for upcoming work?" If yes, keep it.

## Format

- \`ids\`: Array of numeric IDs as strings from the \`<prunable-tools>\` list

## Example

<example_noise>
Assistant: [Reads 'wrong_file.ts']
This file isn't relevant to the auth system. I'll remove it to clear the context.
[Uses prune with ids: ["5"]]
</example_noise>

<example_superseded>
Assistant: [Reads config.ts, then reads updated config.ts after changes]
The first read is now outdated. I'll prune it and keep the updated version.
[Uses prune with ids: ["20"]]
</example_superseded>`
