export const NUDGE_SQUASH = `<instruction name=context_management_required>
**CRITICAL CONTEXT WARNING:** Your context window is filling with tool outputs. Strict adherence to context hygiene is required.

**Immediate Actions Required:**
1. **Phase Completion:** If a phase is complete, use the \`squash\` tool to condense the entire sequence into a summary.
2. **Exploration Done:** If you explored multiple files or ran multiple commands, squash the results to focus on the next phase.

**Protocol:** You should prioritize this cleanup, but do not interrupt a critical atomic operation if one is in progress. Once the immediate step is done, you must squash completed conversation ranges.
</instruction>`
