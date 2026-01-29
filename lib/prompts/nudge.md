<instruction name=context_management_required>
CRITICAL CONTEXT WARNING
Your context window is filling with tool. Strict adherence to context hygiene is required.

PROTOCOL
You should prioritize context management, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.

IMMEDIATE ACTION REQUIRED
<extract>KNOWLEDGE PRESERVATION: If holding valuable raw data you POTENTIALLY will need in your task, use the `extract` tool. Produce a high-fidelity distillation to preserve insights - be thorough</extract>
<discard>NOISE REMOVAL: If you read files or ran commands that yielded no value, use the `discard` tool to remove them. If newer tools supersedes older ones, discard the old</discard>
<squash>PHASE COMPLETION: If a phase is complete, use the `squash` tool to condense the entire sequence into a detailed summary</squash>
</instruction>
