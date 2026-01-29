export const NUDGE_EXTRACT = `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Large Outputs:** If you have large tool outputs with valuable technical details, use the \`extract\` tool to distill and preserve key information.
2. **Knowledge Preservation:** If you are holding valuable raw data you'll need to reference later, use the \`extract\` tool with high-fidelity distillation to preserve the insights and remove the raw entry.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must extract valuable findings from tool outputs.
</instruction>`
