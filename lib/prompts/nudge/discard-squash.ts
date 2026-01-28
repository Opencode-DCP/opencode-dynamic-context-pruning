export const NUDGE_DISCARD_SQUASH = `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Phase Completion:** If a phase is complete, use the \`squash\` tool to condense the entire sequence into a summary.
2. **Noise Removal:** If you read files or ran commands that yielded no value, use the \`discard\` tool to remove them.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must perform context management.
</instruction>`
