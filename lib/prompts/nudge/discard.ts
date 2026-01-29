export const NUDGE_DISCARD = `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Noise Removal:** If you read files or ran commands that yielded no value, use the \`discard\` tool to remove them.
2. **Superseded Info:** If older outputs have been replaced by newer ones, discard the outdated versions.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must discard unneeded tool outputs.
</instruction>`
