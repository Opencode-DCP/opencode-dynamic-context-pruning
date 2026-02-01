export const DISTILL_TOOL_SPEC = `Distills key findings from tool outputs into preserved knowledge, then removes the raw outputs from context.

## IMPORTANT: The Prunable List
A \`<prunable-tools>\` list is provided to you showing available tool outputs you can distill from when there are tools available for pruning. Each line has the format \`ID: tool, parameter\` (e.g., \`20: read, /path/to/file.ts\`). You MUST only use numeric IDs that appear in this list to select which tools to distill.

## Quick Examples

\`\`\`javascript
// Example 1: Distill technical details from file reads
distill({
  items: [
    {
      id: "10",
      distillation: "auth.ts: validateToken(token: string) -> User|null checks cache first (5min TTL) then OIDC. hashPassword uses bcrypt 12 rounds. Tokens must be 128+ chars."
    },
    {
      id: "11",
      distillation: "user.ts: interface User { id: string; email: string; permissions: ('read'|'write'|'admin')[]; status: 'active'|'suspended' }"
    }
  ]
})
\`\`\`

\`\`\`javascript
// Example 2: Distill findings from multiple grep searches
distill({
  items: [
    {
      id: "15",
      distillation: "Found 3 API endpoints: POST /api/login, GET /api/users, DELETE /api/users/:id. All require JWT authentication."
    },
    {
      id: "16",
      distillation: "Found error handling middleware in middleware/errors.ts. Logs errors to file, sends sanitized error response to client."
    }
  ]
})
\`\`\`

## When to Use This Tool

Use \`distill\` when you have individual tool outputs with valuable information you want to **preserve in distilled form** before removing the raw content:

- **Large Outputs:** The raw output is too large but contains valuable technical details worth keeping
- **Knowledge Preservation:** You have context that contains valuable information (signatures, logic, constraints) but also a lot of unnecessary detail
- **Multiple similar operations:** After running several related commands (like multiple grep searches), preserve the consolidated findings

## When NOT to Use This Tool

- **If you need precise syntax:** If you'll edit a file or grep for exact strings, keep the raw output
- **If uncertain:** Prefer keeping over re-fetching
- **For noise removal:** Use \`prune\` for irrelevant or superseded outputs

## Format

- \`items\` — Array of objects, each containing:
  - \`id\` — Numeric ID as string from the \`<prunable-tools>\` list
  - \`distillation\` — String capturing the essential information to preserve

Each distillation string should capture the essential information you need to preserve - function signatures, logic, constraints, values, etc. Be as detailed as needed.

## Best Practices

- **Strategic Batching:** Wait until you have several items or a few large outputs to distill, rather than doing tiny, frequent distillations. Aim for high-impact distillations that significantly reduce context size.
- **Think ahead:** Before distilling, ask: "Will I need the raw output for upcoming work?" If you researched a file you'll later edit, do NOT distill it.
- **Focus on essentials:** Capture what you'll need to recall later (signatures, behaviors, constraints) without unnecessary detail (exact formatting, whitespace, etc.)`
