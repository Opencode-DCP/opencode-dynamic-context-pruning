#!/usr/bin/env npx tsx

import { renderSystemPrompt, renderNudge, type ToolFlags } from "../lib/prompts/index.js"
import {
    wrapPrunableTools,
    wrapSquashContext,
    wrapCooldownMessage,
} from "../lib/messages/inject.js"

const args = process.argv.slice(2)

const flags: ToolFlags = {
    discard: args.includes("-d") || args.includes("--discard"),
    extract: args.includes("-e") || args.includes("--extract"),
    squash: args.includes("-s") || args.includes("--squash"),
}

// Default to all enabled if none specified
if (!flags.discard && !flags.extract && !flags.squash) {
    flags.discard = true
    flags.extract = true
    flags.squash = true
}

const showSystem = args.includes("--system")
const showNudge = args.includes("--nudge")
const showPruneList = args.includes("--prune-list")
const showSquashContext = args.includes("--squash-context")
const showCooldown = args.includes("--cooldown")
const showHelp = args.includes("--help") || args.includes("-h")

if (
    showHelp ||
    (!showSystem && !showNudge && !showPruneList && !showSquashContext && !showCooldown)
) {
    console.log(`
Usage: bun run dcp [TYPE] [-d] [-e] [-s]

Types:
  --system          System prompt
  --nudge           Nudge prompt
  --prune-list      Example prunable tools list
  --squash-context  Example squash context
  --cooldown        Cooldown message after pruning

Tool flags (for --system and --nudge):
  -d, --discard     Enable discard tool
  -e, --extract     Enable extract tool
  -s, --squash      Enable squash tool

If no tool flags specified, all are enabled.

Examples:
  bun run dcp --system -d -e -s   # System prompt with all tools
  bun run dcp --system -d         # System prompt with discard only
  bun run dcp --nudge -e -s       # Nudge with extract and squash
  bun run dcp --prune-list        # Example prunable tools list
`)
    process.exit(0)
}

const header = (title: string) => {
    console.log()
    console.log("─".repeat(60))
    console.log(title)
    console.log("─".repeat(60))
}

if (showSystem) {
    const enabled = [
        flags.discard && "discard",
        flags.extract && "extract",
        flags.squash && "squash",
    ]
        .filter(Boolean)
        .join(", ")
    header(`SYSTEM PROMPT (tools: ${enabled})`)
    console.log(renderSystemPrompt(flags))
}

if (showNudge) {
    const enabled = [
        flags.discard && "discard",
        flags.extract && "extract",
        flags.squash && "squash",
    ]
        .filter(Boolean)
        .join(", ")
    header(`NUDGE (tools: ${enabled})`)
    console.log(renderNudge(flags))
}

if (showPruneList) {
    header("PRUNABLE TOOLS LIST (mock example)")
    const mockList = `5: read, /path/to/file.ts
8: bash, npm run build
12: glob, src/**/*.ts
15: read, /path/to/another-file.ts`
    console.log(wrapPrunableTools(mockList))
}

if (showSquashContext) {
    header("SQUASH CONTEXT (mock example)")
    console.log(wrapSquashContext(45))
}

if (showCooldown) {
    const enabled = [
        flags.discard && "discard",
        flags.extract && "extract",
        flags.squash && "squash",
    ]
        .filter(Boolean)
        .join(", ")
    header(`COOLDOWN MESSAGE (tools: ${enabled})`)
    console.log(wrapCooldownMessage(flags))
}
