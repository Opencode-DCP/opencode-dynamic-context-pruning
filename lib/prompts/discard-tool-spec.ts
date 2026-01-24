export const DISCARD_TOOL_SPEC = `**Purpose:** Discard tool outputs from context to manage size and reduce noise.
**IDs:** Use numeric IDs from \`<prunable-tools>\` (format: \`ID: tool, parameter\`).
**Use When:**
- Noise → irrelevant, unhelpful, or superseded outputs
**Do NOT Use When:**
- Output contains useful information
- Output needed later (files to edit, implementation context)
**Best Practices:**
- Batch multiple items; avoid single small outputs (unless pure noise)
- Criterion: "Needed for upcoming task?" → keep it
**Format:**
- \`ids\`: string[] — numeric IDs from prunable list
**Example:**
Noise removal:
    ids: ["5"]
    Context: Read wrong_file.ts — not relevant to auth system
`
