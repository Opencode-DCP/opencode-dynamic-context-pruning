export const NUDGE_DISCARD_SQUASH = `<instruction name=context_management_required>
**CONTEXT WARNING:** Context filling with tool outputs. Context hygiene required.
**Actions:**
1. Task done → sub-task/phase complete, use \`squash\` to condense into summary
2. Noise → files/commands with no value, use \`discard\`
**Protocol:** Prioritize cleanup. Don't interrupt atomic ops. After immediate step, perform context management.
</instruction>`
