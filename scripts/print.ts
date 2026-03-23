#!/usr/bin/env npx tsx

import { Logger } from "../lib/logger"
import { renderSystemPrompt } from "../lib/prompts"
import { PromptStore, PROMPT_KEYS, type PromptKey, type RuntimePrompts } from "../lib/prompts/store"

function normalizePromptKey(value: string): PromptKey | null {
    const normalized = value.trim().toLowerCase()
    return PROMPT_KEYS.includes(normalized as PromptKey) ? (normalized as PromptKey) : null
}

function getPromptByKey(prompts: RuntimePrompts, key: PromptKey): string {
    switch (key) {
        case "system":
            return prompts.system
        case "compress-range":
            return prompts.compressRange
        case "compress-message":
            return prompts.compressMessage
        case "context-limit-nudge":
            return prompts.contextLimitNudge
        case "turn-nudge":
            return prompts.turnNudge
        case "iteration-nudge":
            return prompts.iterationNudge
    }
}

const args = process.argv.slice(2)
const showHelp = args.includes("-h") || args.includes("--help")

if (showHelp) {
    console.log(`
DCP Prompt Preview CLI

Usage:
  npm run dcp -- [options]

Options:
  --list                   List available prompt keys
  --show <key>             Print effective prompt text for key
  --system                 Print effective system prompt with no overlays
  --system-manual          Print system prompt with manual overlay
  --system-subagent        Print system prompt with subagent overlay
  --system-all             Print system prompt with both overlays

Prompt keys:
  system, compress-range, compress-message,
  context-limit-nudge, turn-nudge, iteration-nudge

Examples:
  npm run dcp -- --list
  npm run dcp -- --show compress-range
  npm run dcp -- --system-all
`)
    process.exit(0)
}

const store = new PromptStore(new Logger(false), process.cwd())
store.reload()

const runtimePrompts = store.getRuntimePrompts()

if (args.includes("--list")) {
    console.log("Available prompts:")
    for (const key of PROMPT_KEYS) {
        console.log(`- ${key}`)
    }
    process.exit(0)
}

const showIndex = args.indexOf("--show")
if (showIndex >= 0) {
    const keyArg = args[showIndex + 1]
    if (!keyArg) {
        console.error("Missing prompt key for --show")
        process.exit(1)
    }

    const key = normalizePromptKey(keyArg)
    if (!key) {
        console.error(`Unknown prompt key: ${keyArg}`)
        process.exit(1)
    }

    console.log(getPromptByKey(runtimePrompts, key))
    process.exit(0)
}

if (args.includes("--system-all")) {
    console.log(renderSystemPrompt(runtimePrompts, true, true))
    process.exit(0)
}

if (args.includes("--system-manual")) {
    console.log(renderSystemPrompt(runtimePrompts, true, false))
    process.exit(0)
}

if (args.includes("--system-subagent")) {
    console.log(renderSystemPrompt(runtimePrompts, false, true))
    process.exit(0)
}

console.log(renderSystemPrompt(runtimePrompts, false, false))
