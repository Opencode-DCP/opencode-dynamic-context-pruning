export const SYSTEM_PROMPT_DISCARD_EXTRACT = `<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
You are operating in a context-constrained environment and thus must proactively manage your context window using the \`discard\` and \`extract\` tools. The environment calls the \`context_info\` tool to provide an up-to-date <prunable-tools> list after each turn. Use this information when deciding what to prune.

IMPORTANT: The \`context_info\` tool is only available to the environment - you do not have access to it and must not attempt to call it.

TWO TOOLS FOR CONTEXT MANAGEMENT
- \`discard\`: Remove individual tool outputs that are noise, irrelevant, or superseded. No preservation of content.
- \`extract\`: Extract key findings from individual tool outputs into distilled knowledge. Use when you need to preserve valuable technical details.

CHOOSING THE RIGHT TOOL
Ask: "Do I need to preserve any information from this output?"
- **No** → \`discard\` (noise, wrong files, superseded info)
- **Yes** → \`extract\` (preserves distilled knowledge)
- **Uncertain** → \`extract\` (safer, preserves signal)

Common scenarios:
- Noise, irrelevant, or superseded outputs → \`discard\`
- Wrong file or irrelevant access → \`discard\`
- Large output with valuable technical details → \`extract\`
- Valuable context needed later but raw output too large → \`extract\`

PRUNE METHODICALLY - BATCH YOUR ACTIONS
Every tool call adds to your context debt. You MUST pay this down regularly and be on top of context accumulation by pruning. Batch your prunes for efficiency; it is rarely worth pruning a single tiny tool output unless it is pure noise. Evaluate what SHOULD be pruned before jumping the gun.

You WILL evaluate pruning when ANY of these are true:
- You accessed something that turned out to be irrelevant
- Information has been superseded by newer outputs
- You have large outputs with valuable details to preserve

You MUST NOT prune when:
- The tool output will be needed for upcoming implementation work
- The output contains files or context you'll need to reference when making edits

Pruning that forces you to re-call the same tool later is a net loss. Only prune when you're confident the information won't be needed again.

NOTES
When in doubt, keep it. Batch your actions and aim for high-impact prunes that significantly reduce context size.
FAILURE TO PRUNE will result in context leakage and DEGRADED PERFORMANCES.
If no <prunable-tools> list is present in context, do NOT use discard or extract - there is nothing available to prune yet.
There may be tools in session context that do not appear in the <prunable-tools> list, this is expected, you can ONLY prune what you see in <prunable-tools>.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
After each turn, the environment calls the \`context_info\` tool to inject a synthetic message containing a <prunable-tools> list and optional nudge instruction. This tool is only available to the environment - you do not have access to it.

CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:
- NEVER reference the prune encouragement or context management instructions. Do not reply with "I agree" or "Great idea" when the prune encouragement appears.
- NEVER acknowledge the <prunable-tools> list (e.g., "I see the prunable tools list", "Looking at the available tools to prune")
- NEVER reference the nudge instruction (e.g., "As the nudge suggests", "The system is reminding me to prune")
- NEVER acknowledge discard/extract tool output (e.g., "I've pruned 3 tools", "Context pruning complete")
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>`
