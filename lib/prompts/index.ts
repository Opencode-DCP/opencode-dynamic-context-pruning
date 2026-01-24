// Tool specs
import { DISCARD_TOOL_SPEC } from "./discard-tool-spec"
import { EXTRACT_TOOL_SPEC } from "./extract-tool-spec"
import { SQUASH_TOOL_SPEC } from "./squash-tool-spec"

// System prompts
import { SYSTEM_PROMPT_DISCARD } from "./system/discard"
import { SYSTEM_PROMPT_EXTRACT } from "./system/extract"
import { SYSTEM_PROMPT_SQUASH } from "./system/squash"
import { SYSTEM_PROMPT_DISCARD_EXTRACT } from "./system/discard-extract"
import { SYSTEM_PROMPT_DISCARD_SQUASH } from "./system/discard-squash"
import { SYSTEM_PROMPT_EXTRACT_SQUASH } from "./system/extract-squash"
import { SYSTEM_PROMPT_ALL } from "./system/all"

// Nudge prompts
import { NUDGE_DISCARD } from "./nudge/discard"
import { NUDGE_EXTRACT } from "./nudge/extract"
import { NUDGE_SQUASH } from "./nudge/squash"
import { NUDGE_DISCARD_EXTRACT } from "./nudge/discard-extract"
import { NUDGE_DISCARD_SQUASH } from "./nudge/discard-squash"
import { NUDGE_EXTRACT_SQUASH } from "./nudge/extract-squash"
import { NUDGE_ALL } from "./nudge/all"

const PROMPTS: Record<string, string> = {
    "discard-tool-spec": DISCARD_TOOL_SPEC,
    "extract-tool-spec": EXTRACT_TOOL_SPEC,
    "squash-tool-spec": SQUASH_TOOL_SPEC,
    "system/system-prompt-discard": SYSTEM_PROMPT_DISCARD,
    "system/system-prompt-extract": SYSTEM_PROMPT_EXTRACT,
    "system/system-prompt-squash": SYSTEM_PROMPT_SQUASH,
    "system/system-prompt-discard-extract": SYSTEM_PROMPT_DISCARD_EXTRACT,
    "system/system-prompt-discard-squash": SYSTEM_PROMPT_DISCARD_SQUASH,
    "system/system-prompt-extract-squash": SYSTEM_PROMPT_EXTRACT_SQUASH,
    "system/system-prompt-all": SYSTEM_PROMPT_ALL,
    "nudge/nudge-discard": NUDGE_DISCARD,
    "nudge/nudge-extract": NUDGE_EXTRACT,
    "nudge/nudge-squash": NUDGE_SQUASH,
    "nudge/nudge-discard-extract": NUDGE_DISCARD_EXTRACT,
    "nudge/nudge-discard-squash": NUDGE_DISCARD_SQUASH,
    "nudge/nudge-extract-squash": NUDGE_EXTRACT_SQUASH,
    "nudge/nudge-all": NUDGE_ALL,
}

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    let content = PROMPTS[name]
    if (!content) {
        throw new Error(`Prompt not found: ${name}`)
    }
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
        }
    }
    return content
}
