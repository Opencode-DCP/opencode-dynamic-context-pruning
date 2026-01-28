export const NUDGE_ALL = `<instruction name=context_management_required>
**CONTEXT WARNING:** Context filling with tool outputs. Context hygiene required.
**Actions:**
1. Task done → use \`squash\` to condense entire sequence into summary
2. Noise → files/commands with no value, use \`discard\`
3. Knowledge → valuable raw data to reference later, use \`extract\` to distill insights
**Protocol:** Prioritize cleanup. Don't interrupt atomic ops. After immediate step, perform context management.
</instruction>`
