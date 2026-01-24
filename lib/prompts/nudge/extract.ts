export const NUDGE_EXTRACT = `<instruction name=context_management_required>
**CONTEXT WARNING:** Context filling with tool outputs. Context hygiene required.
**Actions:**
1. Knowledge → valuable raw data to reference later, use \`extract\` with high-fidelity distillation
2. Phase done → extract key findings to keep context focused
**Protocol:** Prioritize cleanup. Don't interrupt atomic ops. After immediate step, extract valuable findings.
</instruction>`
