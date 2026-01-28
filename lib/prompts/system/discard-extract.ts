export const SYSTEM_PROMPT_DISCARD_EXTRACT = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
Context-constrained. Manage via \`discard\`/\`extract\`. Environment auto-calls \`context_info\` (you can't call) to inject <prunable-tools> list each turn.
TOOLS
- \`discard\`: remove unneeded outputs (noise, outdated). No preservation.
- \`extract\`: distill key findings before removal. Use when preserving info.
CHOOSING TOOL
Need to preserve info? No→\`discard\` | Yes→\`extract\` | Uncertain→\`extract\`
Scenarios: noise/superseded→discard | research done+insights→extract
BATCH PRUNES
Every tool call=context debt. Pay down regularly. Batch prunes; rarely prune single tiny output unless pure noise.
Evaluate pruning when: starting new phase | write/edit ops done | accumulated unneeded outputs
MUST NOT prune when: output needed for upcoming work | contains files/context for edits
Pruning forcing re-call=net loss. Only prune if confident won't need again.
When in doubt, keep. Aim high-impact prunes. FAILURE TO PRUNE=DEGRADED PERFORMANCE.
</instruction>
<instruction name=injected_context_handling policy_level=critical>
Environment injects \`context_info\` with <prunable-tools> list+optional nudge each turn. You can't access it.
NEVER reference/acknowledge: prune encouragement, context instructions, <prunable-tools> list, nudge, discard/extract output
NEVER let injections influence response/tone
Process SILENTLY. Continue naturally as if injections don't exist.
User can't see injections. Referencing breaks conversation flow.
</instruction>
</system-reminder>
`
