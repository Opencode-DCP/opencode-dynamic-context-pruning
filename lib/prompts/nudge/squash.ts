export const NUDGE_SQUASH = `<instruction name=context_management_required>
**CONTEXT WARNING:** Context filling with tool outputs. Context hygiene required.
**Actions:**
1. Task done → sub-task/phase complete, use \`squash\` to condense sequence into summary
2. Exploration done → squash results to focus on next task
**Protocol:** Prioritize cleanup. Don't interrupt atomic ops. After immediate step, squash unneeded ranges.
</instruction>`
