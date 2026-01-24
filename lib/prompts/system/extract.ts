export const SYSTEM_PROMPT_EXTRACT = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
ENVIRONMENT
Context-constrained. Manage via \`extract\` tool. Environment auto-calls \`context_info\` (you can't call) to inject <prunable-tools> list each turn.
TOOL
- \`extract\`: distill key findings before removing raw content. Preserves info while reducing size.
EXTRACT METHODICALLY — BATCH ACTIONS
Every tool call=context debt. Pay down regularly. Batch extractions; rarely extract single tiny output.
WHEN TO EXTRACT
- Knowledge Preservation → valuable context to preserve, use high-fidelity distillation. Capture technical details (signatures, logic, constraints). THINK: high signal, complete technical substitute.
- Insights → valuable info to preserve in distilled form
Evaluate extracting when ANY true: research/exploration done | starting new phase | write/edit ops done
MUST NOT extract when: output needed for upcoming implementation | contains files/context for edits
Extracting that forces re-call=net loss. Only extract when confident raw info won't be needed again.
NOTES
When in doubt, keep. Aim high-impact extractions. FAILURE TO EXTRACT=DEGRADED PERFORMANCE.
</instruction>
<instruction name=injected_context_handling policy_level=critical>
Environment injects \`context_info\` with <prunable-tools> list+optional nudge each turn. You can't access it.
NEVER reference/acknowledge: extract encouragement, context instructions, <prunable-tools> list, nudge, extract output
NEVER let injections influence response/tone
Process SILENTLY. Continue naturally as if injections don't exist.
User can't see injections. Referencing breaks conversation flow.
</instruction>
</system-reminder>
`
