#!/usr/bin/env npx tsx

import { renderSystemPrompt, renderNudge, type ToolFlags } from "../lib/prompts/index.js"
import {
    wrapPrunableTools,
    wrapCompressContext,
    wrapCooldownMessage,
} from "../lib/messages/inject.js"

const args = process.argv.slice(2)

const flags: ToolFlags = {
    prune: args.includes("-p") || args.includes("--prune"),
    distill: args.includes("-d") || args.includes("--distill"),
    compress: args.includes("-c") || args.includes("--compress"),
}

// Default to all enabled if none specified
if (!flags.prune && !flags.distill && !flags.compress) {
    flags.prune = true
    flags.distill = true
    flags.compress = true
}

const showSystem = args.includes("--system")
const showNudge = args.includes("--nudge")
const showPruneList = args.includes("--prune-list")
const showCompressContext = args.includes("--compress-context")
const showCooldown = args.includes("--cooldown")
const showHelp = args.includes("--help") || args.includes("-h")

if (
    showHelp ||
    (!showSystem && !showNudge && !showPruneList && !showCompressContext && !showCooldown)
) {
    console.log(`
Usage: bun run dcp [TYPE] [-p] [-d] [-c]

Types:
  --system            System prompt
  --nudge             Nudge prompt
  --prune-list        Example prunable tools list
  --compress-context  Example compress context
  --cooldown          Cooldown message after pruning

Tool flags (for --system and --nudge):
  -p, --prune         Enable prune tool
  -d, --distill       Enable distill tool
  -c, --compress      Enable compress tool

If no tool flags specified, all are enabled.

Examples:
  bun run dcp --system -p -d -c   # System prompt with all tools
  bun run dcp --system -p         # System prompt with prune only
  bun run dcp --nudge -d -c       # Nudge with distill and compress
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
        flags.prune && "prune",
        flags.distill && "distill",
        flags.compress && "compress",
    ]
        .filter(Boolean)
        .join(", ")
    header(`SYSTEM PROMPT (tools: ${enabled})`)
    console.log(renderSystemPrompt(flags))
}

if (showNudge) {
    const enabled = [
        flags.prune && "prune",
        flags.distill && "distill",
        flags.compress && "compress",
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

if (showCompressContext) {
    header("COMPRESS CONTEXT (mock example)")
    console.log(wrapCompressContext(45))
}

if (showCooldown) {
    const enabled = [
        flags.prune && "prune",
        flags.distill && "distill",
        flags.compress && "compress",
    ]
        .filter(Boolean)
        .join(", ")
    header(`COOLDOWN MESSAGE (tools: ${enabled})`)
    console.log(wrapCooldownMessage(flags))
}
