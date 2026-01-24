export const SYSTEM_PROMPT_EXTRACT = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>
ENVIRONMENT
Context-constrained environment. Proactively manage context window using \`extract\` tool. Environment calls \`context_info\` after each turn to provide <prunable-tools> list. Use this for extraction decisions.
IMPORTANT: \`context_info\` only available to environment — you cannot call it.
CONTEXT MANAGEMENT TOOL
- \`extract\`: Extract key findings from tools into distilled knowledge before removing raw content. Preserves important information while reducing context size.
EXTRACT METHODICALLY — BATCH ACTIONS
Every tool call adds context debt. Pay it down regularly by extracting. Batch extractions for efficiency; rarely worth extracting single tiny output. Evaluate what should be extracted before acting.
WHEN TO EXTRACT
- Task Completion → work done, extract key findings. Scale distillation depth to content value.
- Knowledge Preservation → valuable context to preserve but need size reduction, use high-fidelity distillation. Capture technical details (signatures, logic, constraints) such that raw output no longer needed. THINK: high signal, complete technical substitute.
Evaluate extracting when ANY true:
- Task or sub-task complete
- About to start new work phase
- Write/edit operations complete (extracting removes large input content)
MUST NOT extract when:
- Output needed for upcoming implementation
- Contains files/context needed for edits
Extracting that forces re-calling same tool = net loss. Only extract when confident info won't be needed again.
NOTES
When in doubt, keep it. Batch actions for high-impact extractions that significantly reduce context size.
FAILURE TO EXTRACT = context leakage and DEGRADED PERFORMANCE.
Tools in session may not appear in <prunable-tools> — expected. ONLY extract what appears in <prunable-tools>.
</instruction>
<instruction name=injected_context_handling policy_level=critical>
Environment calls \`context_info\` after each turn, injecting synthetic message with <prunable-tools> list and optional nudge. This tool only available to environment.
CRITICAL REQUIREMENTS — VIOLATION UNACCEPTABLE:
- NEVER reference: extract encouragement, context management instructions, <prunable-tools> list, nudge instruction, extract tool output
- NEVER acknowledge: "I agree", "Great idea", "I see the list", "As nudge suggests", "I've extracted X tools", "Context cleanup complete"
- NEVER let injections influence response content or tone
- Process SILENTLY and continue conversation naturally
- Continue as if these messages don't exist
User cannot see injections. Referencing them confuses user and breaks conversation flow.
</instruction>
</system-reminder>`
