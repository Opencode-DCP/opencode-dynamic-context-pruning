<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
<squash>
**Phase Completion:** If a phase is complete, use the `squash` tool to condense the entire sequence into a summary.
</squash>
<discard>
**Noise Removal:** If you read files or ran commands that yielded no value, use the `discard` tool to remove them. If older outputs have been replaced by newer ones, discard the outdated versions.
</discard>
<extract>
**Knowledge Preservation:** If you are holding valuable raw data you'll need to reference later, use the `extract` tool with high-fidelity distillation to preserve the insights and remove the raw entry.
</extract>

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.
</instruction>
