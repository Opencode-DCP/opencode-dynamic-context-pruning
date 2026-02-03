#!/usr/bin/env tsx
/**
 * Prebuild script that generates TypeScript files from Markdown prompts.
 *
 * This solves the issue where readFileSync with __dirname fails when the
 * package is bundled by Bun (see issue #222, PR #272, #327).
 *
 * The .md files are kept for convenient editing, and this script generates
 * .ts files with exported string constants that bundle correctly.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, join, basename } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(__dirname, "..", "lib", "prompts")
const CODEGEN_DIR = join(PROMPTS_DIR, "_codegen")

// Ensure _codegen directory exists
mkdirSync(CODEGEN_DIR, { recursive: true })

// MIGRATION - Clean up old generated files from the prompts directory root (they're now in _codegen/)
const oldGeneratedFiles = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".generated.ts"))
for (const file of oldGeneratedFiles) {
    unlinkSync(join(PROMPTS_DIR, file))
    console.log(`Cleaned up old: ${file}`)
}

// Find all .md files in the prompts directory
const mdFiles = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"))

for (const mdFile of mdFiles) {
    const mdPath = join(PROMPTS_DIR, mdFile)
    const baseName = basename(mdFile, ".md")
    const constName = baseName.toUpperCase().replace(/-/g, "_")
    const tsPath = join(CODEGEN_DIR, `${baseName}.generated.ts`)

    const content = readFileSync(mdPath, "utf-8")

    // Escape backticks and ${} template expressions for safe embedding in template literal
    const escaped = content.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")

    const tsContent = `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from ${mdFile} by scripts/generate-prompts.ts
// To modify, edit ${mdFile} and run \`npm run generate:prompts\`

export const ${constName} = \`${escaped}\`
`

    writeFileSync(tsPath, tsContent)
    console.log(`Generated: ${baseName}.generated.ts`)
}

console.log(`Done! Generated ${mdFiles.length} TypeScript file(s) from Markdown prompts.`)
