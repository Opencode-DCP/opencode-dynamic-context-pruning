// Tool specs
import { PRUNE_TOOL_SPEC } from "./prune-tool-spec"
import { DISTILL_TOOL_SPEC } from "./distill-tool-spec"
import { COMPRESS_TOOL_SPEC } from "./compress-tool-spec"

// Generated prompts (from .md files via scripts/generate-prompts.ts)
import { SYSTEM as SYSTEM_PROMPT } from "./system.generated"
import { NUDGE } from "./nudge.generated"

export interface ToolFlags {
    distill: boolean
    compress: boolean
    prune: boolean
}

function processConditionals(template: string, flags: ToolFlags): string {
    const tools = ["distill", "compress", "prune"] as const
    let result = template
    // Strip comments: // ... //
    result = result.replace(/\/\/.*?\/\//g, "")
    // Process tool conditionals
    for (const tool of tools) {
        const regex = new RegExp(`<${tool}>([\\s\\S]*?)</${tool}>`, "g")
        result = result.replace(regex, (_, content) => (flags[tool] ? content : ""))
    }
    // Collapse multiple blank/whitespace-only lines to single blank line
    return result.replace(/\n([ \t]*\n)+/g, "\n\n").trim()
}

export function renderSystemPrompt(flags: ToolFlags): string {
    return processConditionals(SYSTEM_PROMPT, flags)
}

export function renderNudge(flags: ToolFlags): string {
    return processConditionals(NUDGE, flags)
}

const PROMPTS: Record<string, string> = {
    "prune-tool-spec": PRUNE_TOOL_SPEC,
    "distill-tool-spec": DISTILL_TOOL_SPEC,
    "compress-tool-spec": COMPRESS_TOOL_SPEC,
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
