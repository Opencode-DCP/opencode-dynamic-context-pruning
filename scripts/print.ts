#!/usr/bin/env npx tsx

import { renderSystemPrompt, renderNudge } from "../lib/prompts"

const args = process.argv.slice(2)
const showHelp = args.includes("-h") || args.includes("--help")

if (showHelp) {
    console.log(`
DCP Prompt Preview CLI

Usage:
  bun run dcp [TYPE]

Types:
  --system            Print system prompt
  --nudge             Print standard nudge prompt
  --compress-nudge    Print context-limit compress nudge

Examples:
  bun run dcp --system
  bun run dcp --nudge
  bun run dcp --compress-nudge
`)
    process.exit(0)
}

const isSystem = args.includes("--system") || args.length === 0
const isNudge = args.includes("--nudge")
const isCompressNudge = args.includes("--compress-nudge")

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
