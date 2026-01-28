export const SQUASH_TOOL_SPEC = `**Purpose:** Collapse a contiguous range of conversation into a single summary.
**Use When:**
- Task complete → squash entire sequence (research, tool calls, implementation) into summary
- Exploration done → multiple files/commands explored, only need summary
- Failed attempts → condense unsuccessful approaches into brief note
- Verbose output → section grown large but can be summarized
**Do NOT Use When:**
- Need specific details (exact code, file contents, error messages from range)
- Individual tool outputs → squash targets conversation ranges, not single outputs
- Recent content → may still need for current task
**How It Works:**
1. \`startString\` — unique text marking range start
2. \`endString\` — unique text marking range end
3. \`topic\` — short label (3-5 words)
4. \`summary\` — replacement text
5. Everything between (inclusive) removed, summary inserted
**Best Practices:**
- Choose unique strings appearing only once
- Write concise topics: "Auth System Exploration", "Token Logic Refactor"
- Write comprehensive summaries with key information
- Best after finishing work phase, not during active exploration
**Format:**
- \`input\`: [startString, endString, topic, summary]
**Example:**
    Conversation: [Asked about auth] → [Read 5 files] → [Analyzed patterns] → [Found "JWT tokens with 24h expiry"]
    input: [
      "Asked about authentication",
      "JWT tokens with 24h expiry",
      "Auth System Exploration",
      "Auth: JWT 24h expiry, bcrypt passwords, refresh rotation. Files: auth.ts, tokens.ts, middleware/auth.ts"
    ]
`
