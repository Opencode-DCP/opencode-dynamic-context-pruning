#!/usr/bin/env npx tsx

import { renderSystemPrompt, renderNudge } from "../lib/prompts"
import {
    wrapContextPressureTools,
    wrapCompressContext,
    wrapCooldownMessage,
} from "../lib/messages/inject"

const args = process.argv.slice(2)

if (args.includes("-h") || args.includes("--help")) {
    console.log(`
DCP Prompt Preview CLI

Usage:
  bun run dcp [TYPE]

Types:
  --system            Print system prompt
  --nudge             Print standard nudge prompt
  --compress-nudge    Print context-limit compress nudge
  --context-tools     Print example <context-pressure-tools> block
  --compress-context  Print example <compress-context> block
  --cooldown          Print cooldown context-info block

Examples:
  bun run dcp --system
  bun run dcp --nudge
  bun run dcp --context-tools
`)
    process.exit(0)
}

const isSystem = args.includes("--system") || args.length === 0
const isNudge = args.includes("--nudge")
const isCompressNudge = args.includes("--compress-nudge")
const isContextTools = args.includes("--context-tools") || args.includes("--prune-list")
const isCompressContext = args.includes("--compress-context")
const isCooldown = args.includes("--cooldown")

if (isSystem) {
    console.log("=== SYSTEM ===\n")
    console.log(renderSystemPrompt())
}

if (isNudge) {
    console.log("=== NUDGE ===\n")
    console.log(renderNudge("frequency"))
}

if (isCompressNudge) {
    console.log("=== COMPRESS NUDGE ===\n")
    console.log(renderNudge("context-limit"))
}

if (isContextTools) {
    console.log("=== CONTEXT TOOLS ===\n")
    console.log(
        wrapContextPressureTools(
            [
                "- read, /repo/src/app.ts (~1540 tokens)",
                '- grep, "compress" in /repo/lib (~260 tokens)',
                "- bash, Shows git status (~100 tokens)",
            ].join("\n"),
        ),
    )
}

if (isCompressContext) {
    console.log("=== COMPRESS CONTEXT ===\n")
    console.log(wrapCompressContext(128))
}

if (isCooldown) {
    console.log("=== COOLDOWN ===\n")
    console.log(wrapCooldownMessage())
}
