import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Tool specs
import { PRUNE_TOOL_SPEC } from "./prune-tool-spec"
import { DISTILL_TOOL_SPEC } from "./distill-tool-spec"
import { COMPRESS_TOOL_SPEC } from "./compress-tool-spec"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load markdown prompts at module init
const SYSTEM_PROMPT = readFileSync(join(__dirname, "system.md"), "utf-8")
const NUDGE = readFileSync(join(__dirname, "nudge.md"), "utf-8")

export interface ToolFlags {
    prune: boolean
    distill: boolean
    compress: boolean
}

function processConditionals(template: string, flags: ToolFlags): string {
    const tools = ["prune", "distill", "compress"] as const
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
