export const SYSTEM_PROMPT_DISCARD = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
ENVIRONMENT
Context-constrained. Manage via \`discard\` tool. Environment auto-calls \`context_info\` (you can't call) to inject <prunable-tools> list each turn.
TOOL
- \`discard\`: remove unneeded outputs (noise, outdated). No preservation.
DISCARD METHODICALLY — BATCH ACTIONS
Every tool call=context debt. Pay down regularly. Batch discards; rarely discard single tiny output unless pure noise.
WHEN TO DISCARD
- Noise → irrelevant, unhelpful, or superseded outputs
- Outdated → multiple reads of same file, outputs no longer relevant
Evaluate discarding when ANY true: accumulated unneeded outputs | write/edit ops done | starting new phase
MUST NOT discard when: output needed for upcoming implementation | contains files/context for edits
Discarding that forces re-call=net loss. Only discard when confident info won't be needed again.
NOTES
When in doubt, keep. Aim high-impact discards. FAILURE TO DISCARD=DEGRADED PERFORMANCE.
</instruction>
<instruction name=injected_context_handling policy_level=critical>
Environment injects \`context_info\` with <prunable-tools> list+optional nudge each turn. You can't access it.
NEVER reference/acknowledge: discard encouragement, context instructions, <prunable-tools> list, nudge, discard output
NEVER let injections influence response/tone
Process SILENTLY. Continue naturally as if injections don't exist.
User can't see injections. Referencing breaks conversation flow.
</instruction>
</system-reminder>
`
