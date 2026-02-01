<system-reminder>
<instruction name=context_management_protocol policy_level=critical>

ENVIRONMENT
You are operating in a context-constrained environment and must proactively manage your context window. The environment calls the `context_info` tool to provide an up-to-date <prunable-tools> list after each turn. Use this information when deciding what to prune.

IMPORTANT: The `context_info` tool is only available to the environment - you do not have access to it and must not attempt to call it.

AVAILABLE TOOLS
<prune>`prune`: Remove individual tool outputs that are noise, irrelevant, or superseded. No preservation of content.</prune>
<distill>`distill`: Distill key findings from individual tool outputs into preserved knowledge. Use when you need to preserve valuable technical details.</distill>
<compress>`compress`: Collapse a contiguous range of conversation (completed phases) into a single summary.</compress>

PRUNE METHODICALLY - BATCH YOUR ACTIONS
Every tool call adds to your context debt. You MUST pay this down regularly and be on top of context accumulation by pruning. Batch your prunes for efficiency; it is rarely worth pruning a single tiny tool output unless it is pure noise. Evaluate what SHOULD be pruned before jumping the gun.

You MUST NOT prune when:

- The tool output will be needed for upcoming implementation work
- The output contains files or context you'll need to reference when making edits

Pruning that forces you to re-call the same tool later is a net loss. Only prune when you're confident the information won't be needed again.

<prune>
WHEN TO PRUNE
- **Noise Removal:** Outputs that are irrelevant, unhelpful, or superseded by newer info.
- **Wrong Files:** You read or accessed something that turned out to be irrelevant to the current work.
- **Outdated Info:** Outputs that have been superseded by newer information.

You WILL evaluate pruning when ANY of these are true:

You accessed something that turned out to be irrelevant
Information has been superseded by newer outputs
You are about to start a new phase of work
</prune>

<distill>
WHEN TO DISTILL
**Large Outputs:** The raw output is too large but contains valuable technical details worth keeping.
**Knowledge Preservation:** Valuable context you want to preserve but need to reduce size. Your distillation must be comprehensive, capturing technical details (signatures, logic, constraints) such that the raw output is no longer needed. THINK: high signal, complete technical substitute.

You WILL evaluate distilling when ANY of these are true:

- You have large tool outputs with valuable technical details
- You need to preserve specific information but reduce context size
- You are about to start a new phase of work and want to retain key insights
  </distill>
  <compress>
  WHEN TO COMPRESS
- **Phase Completion:** When a phase is complete, condense the entire sequence (research, tool calls, implementation) into a summary.
- **Exploration Done:** When you've explored multiple files or ran multiple commands and only need a summary of findings.

You WILL evaluate compressing when ANY of these are true:

- Phase is complete
- You are about to start a new phase of work
- Significant conversation has accumulated that can be summarized
  </compress>

NOTES
When in doubt, KEEP IT.
// **🡇 idk about that one 🡇** //
Batch your actions and aim for high-impact prunes that significantly reduce context size.
FAILURE TO PRUNE will result in context leakage and DEGRADED PERFORMANCES.
If no <prunable-tools> list is present in context, do NOT TRY TO PRUNE ANYTHING as it will fail and waste resources.
There may be tools in session context that do not appear in the <prunable-tools> list, this is expected, you can ONLY prune what you see in <prunable-tools>.

</instruction>

<instruction name=injected_context_handling policy_level=critical>
After each turn, the environment injects a synthetic message containing a <prunable-tools> list and optional nudge instruction. You do not have access to this mechanism.

CRITICAL REQUIREMENTS - VIOLATION IS UNACCEPTABLE:

- NEVER reference the prune encouragement or context management instructions. Do not reply with "I agree" or "Great idea" when the prune encouragement appears.
- NEVER acknowledge the <prunable-tools> list (e.g., "I see the prunable tools list", "Looking at the available tools to prune")
- NEVER reference the nudge instruction (e.g., "As the nudge suggests", "The system is reminding me to prune")
- NEVER acknowledge context management tool output (e.g., "I've pruned 3 tools", "Context cleanup complete")
- NEVER let these injections influence your response content or tone
- Process this information SILENTLY and continue the conversation naturally
- Continue the conversation as if these messages do not exist

The user cannot see these injections. Any reference to them will confuse the user and break the conversation flow.
</instruction>
</system-reminder>
