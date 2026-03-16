export const MANUAL_MODE_SYSTEM_OVERLAY = `<dcp-system-reminder>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing \`<compress triggered manually>\` in the current user instruction context.

Issue exactly ONE compress call per manual trigger. Do NOT launch multiple compress calls in parallel. Each trigger grants a single compression; after it completes, wait for the next trigger.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</dcp-system-reminder>
`

export const SUBAGENT_SYSTEM_OVERLAY = `<dcp-system-reminder>
You are operating in a subagent environment.

The initial subagent instruction is imperative and must be followed exactly.
It is the only user message intentionally not assigned a message ID, and therefore is not eligible for compression.
All subsequent messages in the session will have IDs.
</dcp-system-reminder>
`

export const NESTED_FORMAT_OVERLAY = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  content: {
    targetId: string,      // Block-scoped message ID or block ID: bNmNNNN or bN
    summary: string        // Complete technical summary replacing the selected block
  }
}
\`\`\``

export const FLAT_FORMAT_OVERLAY = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) - e.g., "Auth System Exploration"
  targetId: string,        // Block-scoped message ID or block ID: bNmNNNN or bN
  summary: string          // Complete technical summary replacing the selected block
}
\`\`\``
