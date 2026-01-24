export const NUDGE_DISCARD = `<instruction name=context_management_required>
**CONTEXT WARNING:** Context filling with tool outputs. Context hygiene required.
**Actions:**
1. Noise → files/commands with no value, use \`discard\`
2. Outdated → outputs no longer relevant, discard
**Protocol:** Prioritize cleanup. Don't interrupt atomic ops. After immediate step, discard unneeded outputs.
</instruction>`
