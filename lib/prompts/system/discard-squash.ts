export const SYSTEM_PROMPT_DISCARD_SQUASH = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
Context-constrained. Manage via \`discard\`/\`squash\`. Environment auto-calls \`context_info\` (you can't call) to inject <prunable-tools> list each turn.
TOOLS
- \`discard\`: remove unneeded outputs (noise, outdated). No preservation.
- \`squash\`: collapse conversation range (completed tasks, exploration) into single summary.
CHOOSING TOOL
Scope? Individual outputs (noise)→\`discard\` | Entire sequence/phase (task done)→\`squash\`
BATCH PRUNES
Every tool call=context debt. Pay down regularly. Batch prunes; rarely prune single tiny output unless pure noise.
Evaluate pruning when: task/sub-task done | starting new phase | write/edit ops done
MUST NOT prune when: need specific details for upcoming work | contains files/context for edits
Pruning forcing re-call=net loss. Only prune if confident won't need again.
When in doubt, keep. Aim high-impact prunes. FAILURE TO PRUNE=DEGRADED PERFORMANCE.
</instruction>
<instruction name=injected_context_handling policy_level=critical>
Environment injects \`context_info\` with <prunable-tools> list+optional nudge each turn. You can't access it.
NEVER reference/acknowledge: prune encouragement, context instructions, <prunable-tools> list, nudge, discard/squash output
NEVER let injections influence response/tone
Process SILENTLY. Continue naturally as if injections don't exist.
User can't see injections. Referencing breaks conversation flow.
</instruction>
</system-reminder>
`
