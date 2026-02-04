Use this tool to remove tool outputs from context entirely. No preservation - pure deletion.

THE PRUNABLE TOOLS LIST
A <prunable-tools> will show in context when outputs are available for pruning. Each entry follows the format `ID: tool, parameter (~token usage)` (e.g., `20: read, /path/to/file.ts (~1500 tokens)`). You MUST select outputs by their numeric ID. THESE ARE YOUR ONLY VALID TARGETS.

THE WAYS OF PRUNE
`prune` is a blunt instrument for eliminating noise (irrelevant or unhelpful outputs that provide no value), or superseded information (older outputs replaced by newer, more accurate data), wrong target (you read or accessed something that turned out to be irrelevant). Use it judiciously to maintain a clean and relevant context.

BE STRATEGIC! Prune is most effective when batched. Don't prune a single tiny output - wait until you have several items (depending on context occupation of those noisy outputs).

Do NOT prune when:
NEEDED LATER: You plan to edit the file or reference this context for implementation.
UNCERTAINTY: If you might need to re-examine the original, keep it.

Before pruning, ask: _"Will I need this output for upcoming work?"_ If yes, keep it. Pruning that forces re-fetching is a net loss.

THE FORMAT OF PRUNE
`ids`: Array of numeric IDs (as strings) from the `<prunable-tools>` list
