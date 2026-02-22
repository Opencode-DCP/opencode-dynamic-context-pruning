import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated"
import { NUDGE } from "./nudge"
import { COMPRESS } from "./compress"
import { TURN_NUDGE } from "./turn-nudge"

export { COMPRESS as COMPRESS_TOOL_SPEC }

export function renderSystemPrompt(manual?: boolean): string {
    let result = SYSTEM_PROMPT
    result = result.replace(/\/\/.*?\/\//g, "")

    if (!manual) {
        const regex = new RegExp(`<manual>[\\s\\S]*?</manual>`, "g")
        result = result.replace(regex, "")
    }

    return result.replace(/\n([ \t]*\n)+/g, "\n\n").trim()
}

function extractInstruction(content: string, name: string): string {
    const regex = new RegExp(
        `<instruction\\s+name=(?:"${name}"|${name})[^>]*>[\\s\\S]*?<\\/instruction>`,
        "i",
    )
    const match = content.match(regex)
    return match ? match[0] : content
}

export const CONTEXT_LIMIT_NUDGE = extractInstruction(NUDGE, "context_buildup_warning")
export const TURN_NUDGE_PROMPT = extractInstruction(TURN_NUDGE, "post_loop_turn_nudge")
