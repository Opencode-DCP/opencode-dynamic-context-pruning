export const EXTRACT_TOOL_SPEC = `**Purpose:** Extract key findings from tool outputs into distilled knowledge; remove raw outputs from context.
**IDs:** Use numeric IDs from \`<prunable-tools>\` (format: \`ID: tool, parameter\`).
**Use When:**
- Task complete → preserve findings
- Distill context → keep specifics, drop noise
**Do NOT Use When:**
- Need exact syntax (edits/grep) → keep raw output
- Planning modifications → keep read output
**Best Practices:**
- Batch multiple items; avoid frequent small extractions
- Preserve raw output if editing/modifying later
**Format:**
- \`ids\`: string[] — numeric IDs from prunable list
- \`distillation\`: string[] — positional mapping (distillation[i] for ids[i])
- Detail level: signatures, logic, constraints, values
**Example:**
    \`ids\`: ["10", "11"]
    \`distillation\`: [
      "auth.ts: validateToken(token: string)→User|null. Cache 5min TTL then OIDC. bcrypt 12 rounds. Tokens ≥128 chars.",
      "user.ts: interface User {id: string; email: string; permissions: ('read'|'write'|'admin')[]; status: 'active'|'suspended'}"
    ]
`
