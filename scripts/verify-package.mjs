import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const repoRoot = new URL("../", import.meta.url)
const packageJsonPath = new URL("./package.json", repoRoot)
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))

const requiredRepoFiles = [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/tui/index.d.ts",
    "index.ts",
    "lib/config.ts",
    "tui/index.tsx",
    "tui/data/context.ts",
    "tui/routes/summary.tsx",
    "tui/shared/names.ts",
    "tui/shared/theme.ts",
    "tui/shared/types.ts",
    "tui/slots/sidebar-content.tsx",
    "README.md",
    "LICENSE",
    "dcp.schema.json",
]

const requiredTarballFiles = [
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/tui/index.d.ts",
    "index.ts",
    "lib/config.ts",
    "tui/index.tsx",
    "tui/data/context.ts",
    "tui/routes/summary.tsx",
    "tui/shared/names.ts",
    "tui/shared/theme.ts",
    "tui/shared/types.ts",
    "tui/slots/sidebar-content.tsx",
    "README.md",
    "LICENSE",
    "dcp.schema.json",
]

const forbiddenTarballPatterns = [
    /^tui\/node_modules\//,
    /^node_modules\//,
    /^tests\//,
    /^scripts\//,
    /^docs\//,
    /^assets\//,
    /^notes\//,
    /^\.github\//,
    /^package-lock\.json$/,
]

const fail = (message) => {
    console.error(`package verification failed: ${message}`)
    process.exit(1)
}

for (const relativePath of requiredRepoFiles) {
    const absolutePath = new URL(`./${relativePath}`, repoRoot)
    if (!existsSync(absolutePath)) {
        fail(`missing required repo file '${relativePath}'`)
    }
}

if (packageJson.exports?.["."]?.import !== "./dist/index.js") {
    fail("expected package.json exports['.'].import to be './dist/index.js'")
}

if (packageJson.exports?.["./server"]?.import !== "./dist/index.js") {
    fail("expected package.json exports['./server'].import to be './dist/index.js'")
}

if (packageJson.exports?.["./tui"]?.import !== "./tui/index.tsx") {
    fail("expected package.json exports['./tui'].import to be './tui/index.tsx'")
}

const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
})

const packResult = JSON.parse(packOutput)
if (!Array.isArray(packResult) || packResult.length !== 1 || !Array.isArray(packResult[0]?.files)) {
    fail("unexpected npm pack JSON output")
}

const tarballFiles = new Set(packResult[0].files.map((entry) => entry.path))

for (const relativePath of requiredTarballFiles) {
    if (!tarballFiles.has(relativePath)) {
        fail(`tarball is missing required file '${relativePath}'`)
    }
}

for (const relativePath of tarballFiles) {
    for (const pattern of forbiddenTarballPatterns) {
        if (pattern.test(relativePath)) {
            fail(`tarball contains forbidden path '${relativePath}'`)
        }
    }
}

console.log(`package verification passed for ${packageJson.name}@${packageJson.version}`)
console.log(`tarball entries: ${packResult[0].entryCount}`)
