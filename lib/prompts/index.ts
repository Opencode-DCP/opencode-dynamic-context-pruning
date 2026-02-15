// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated"
import { NUDGE } from "./_codegen/nudge.generated"
import { COMPRESS } from "./_codegen/compress.generated"

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

type NudgeMode = "frequency" | "context-limit"

function extractInstruction(content: string, name: string): string {
    const regex = new RegExp(
        `<instruction\\s+name=(?:"${name}"|${name})[^>]*>[\\s\\S]*?<\\/instruction>`,
        "i",
    )
    const match = content.match(regex)
    return match ? match[0] : content
}

export function renderNudge(mode: NudgeMode = "frequency"): string {
    if (mode === "context-limit") {
        return extractInstruction(NUDGE, "context_buildup_warning")
    }

    return extractInstruction(NUDGE, "context_management_required")
}
