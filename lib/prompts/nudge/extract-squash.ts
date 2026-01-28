export const NUDGE_EXTRACT_SQUASH = `<instruction name=context_management_required>
**CONTEXT WARNING:** Context filling with tool outputs. Context hygiene required.
**Actions:**
1. Task done → sub-task/phase complete, use \`squash\` to condense into summary
2. Knowledge → valuable raw data to reference later, use \`extract\` to distill insights
**Protocol:** Prioritize cleanup. Don't interrupt atomic ops. After immediate step, perform context management.
</instruction>`
