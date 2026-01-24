export const DISCARD_TOOL_SPEC = `**Purpose:** Discard tool outputs from context to manage size and reduce noise.
**IDs:** Use numeric IDs from \`<prunable-tools>\` (format: \`ID: tool, parameter\`).
**Use When:**
- Noise → irrelevant, unhelpful, or superseded outputs
- Task complete → no valuable info to preserve
**Do NOT Use When:**
- Output contains useful information
- Output needed later (files to edit, implementation context)
**Best Practices:**
- Batch multiple items; avoid single small outputs (unless pure noise)
- Criterion: "Needed for upcoming task?" → keep it
**Format:**
- \`ids\`: [reason, ...numeric IDs] — reason: \`noise\` | \`completion\`
**Examples:**
Noise removal:
    ids: ["noise", "5"]
    Context: Read wrong_file.ts — not relevant to auth system
Task completion:
    ids: ["completion", "20", "21"]
    Context: Tests passed, no details needed
`
