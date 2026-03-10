import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const repoRoot = path.resolve(import.meta.dirname, "..")
const tuiNodeModules = path.join(repoRoot, "tui", "node_modules")
const hostRoot = path.resolve(
    process.argv[2] ?? process.env.OPENCODE_SOURCE_ROOT ?? "/home/dan/src/opencode",
)
const hostEntry = path.join(hostRoot, "packages", "opencode", "src", "cli", "cmd", "tui", "app.tsx")
const pluginEntry = path.join(repoRoot, "tui", "index.tsx")

if (!fs.existsSync(hostEntry)) {
    throw new Error(`OpenCode TUI entry not found: ${hostEntry}`)
}

const hostRequire = createRequire(hostEntry)
const pluginRequire = createRequire(pluginEntry)

const findPackageRoot = (resolvedFile) => {
    let current = path.dirname(resolvedFile)
    while (true) {
        const manifest = path.join(current, "package.json")
        if (fs.existsSync(manifest)) return current
        const parent = path.dirname(current)
        if (parent === current) {
            throw new Error(`Could not find package root for ${resolvedFile}`)
        }
        current = parent
    }
}

const resolveHostPackage = (specifier) => findPackageRoot(hostRequire.resolve(specifier))
const resolvePluginPackage = (specifier) => findPackageRoot(pluginRequire.resolve(specifier))

const links = [
    {
        specifier: "solid-js",
        dest: path.join(tuiNodeModules, "solid-js"),
    },
    {
        specifier: "@opentui/solid",
        dest: path.join(tuiNodeModules, "@opentui", "solid"),
    },
    {
        specifier: "@opentui/core",
        dest: path.join(tuiNodeModules, "@opentui", "core"),
    },
]

for (const link of links) {
    const target = resolveHostPackage(link.specifier)
    fs.mkdirSync(path.dirname(link.dest), { recursive: true })
    fs.rmSync(link.dest, { recursive: true, force: true })
    fs.symlinkSync(target, link.dest, "dir")

    const pluginResolved = resolvePluginPackage(link.specifier)
    const pluginReal = fs.realpathSync.native(pluginResolved)
    const targetReal = fs.realpathSync.native(target)
    if (pluginReal !== targetReal) {
        throw new Error(`Failed to link ${link.specifier}: ${pluginReal} != ${targetReal}`)
    }

    console.log(`linked ${link.specifier}`)
    console.log(`  host:   ${targetReal}`)
    console.log(`  plugin: ${pluginReal}`)
}
