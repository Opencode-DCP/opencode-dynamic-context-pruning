import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Tool specs
import { DISCARD_TOOL_SPEC } from "./discard-tool-spec"
import { EXTRACT_TOOL_SPEC } from "./extract-tool-spec"
import { SQUASH_TOOL_SPEC } from "./squash-tool-spec"

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load markdown prompts at module init
const SYSTEM_PROMPT = readFileSync(join(__dirname, "system.md"), "utf-8")
const NUDGE = readFileSync(join(__dirname, "nudge.md"), "utf-8")

export interface ToolFlags {
    discard: boolean
    extract: boolean
    squash: boolean
}

function processConditionals(template: string, flags: ToolFlags): string {
    const tools = ["discard", "extract", "squash"] as const
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
    "discard-tool-spec": DISCARD_TOOL_SPEC,
    "extract-tool-spec": EXTRACT_TOOL_SPEC,
    "squash-tool-spec": SQUASH_TOOL_SPEC,
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
