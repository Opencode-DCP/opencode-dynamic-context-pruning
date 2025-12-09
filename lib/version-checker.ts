import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'

export const PACKAGE_NAME = '@tarquinen/opencode-dcp'
export const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function getLocalVersion(): string {
    try {
        let dir = __dirname
        for (let i = 0; i < 5; i++) {
            const pkgPath = join(dir, 'package.json')
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
                if (pkg.name === PACKAGE_NAME) {
                    return pkg.version
                }
            } catch {
                // Not found at this level, go up
            }
            dir = join(dir, '..')
        }
        return '0.0.0'
    } catch {
        return '0.0.0'
    }
}

export async function getNpmVersion(): Promise<string | null> {
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)

        const res = await fetch(NPM_REGISTRY_URL, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        })
        clearTimeout(timeout)

        if (!res.ok) return null
        const data = await res.json() as { version?: string }
        return data.version ?? null
    } catch {
        return null
    }
}

export function isOutdated(local: string, remote: string): boolean {
    const parseVersion = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0)
    const [localParts, remoteParts] = [parseVersion(local), parseVersion(remote)]

    for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
        const l = localParts[i] ?? 0
        const r = remoteParts[i] ?? 0
        if (r > l) return true
        if (l > r) return false
    }
    return false
}

/**
 * Updates config files to pin the new version.
 * Checks both global and local project configs.
 * Handles: "@tarquinen/opencode-dcp", "@tarquinen/opencode-dcp@latest", "@tarquinen/opencode-dcp@1.2.3"
 */
export function updateConfigVersion(newVersion: string, logger?: { info: (component: string, message: string, data?: any) => void }): boolean {
    const configs = [
        join(homedir(), '.config', 'opencode', 'opencode.jsonc'), // Global
        join(process.cwd(), '.opencode', 'opencode.jsonc')        // Local project
    ]

    let anyUpdated = false

    for (const configPath of configs) {
        try {
            if (!existsSync(configPath)) continue

            const content = readFileSync(configPath, 'utf-8')

            // Match @tarquinen/opencode-dcp with optional version suffix (latest, 1.2.3, etc)
            // The regex matches: " @tarquinen/opencode-dcp (optional @anything) "
            const regex = new RegExp(`"${PACKAGE_NAME}(@[^"]*)?"`,'g')
            const newEntry = `"${PACKAGE_NAME}@${newVersion}"`

            if (!regex.test(content)) {
                continue
            }

            // Reset regex state
            regex.lastIndex = 0
            const updatedContent = content.replace(regex, newEntry)

            if (updatedContent !== content) {
                writeFileSync(configPath, updatedContent, 'utf-8')
                logger?.info("version", "Config updated", { configPath, newVersion })
                anyUpdated = true
            }
        } catch (err) {
            logger?.info("version", "Failed to update config", { configPath, error: (err as Error).message })
        }
    }

    return anyUpdated
}

export async function checkForUpdates(
    client: any,
    logger?: { info: (component: string, message: string, data?: any) => void }
): Promise<void> {
    try {
        const local = getLocalVersion()
        const npm = await getNpmVersion()

        if (!npm) {
            logger?.info("version", "Version check skipped", { reason: "npm fetch failed" })
            return
        }

        if (!isOutdated(local, npm)) {
            logger?.info("version", "Up to date", { local, npm })
            return
        }

        logger?.info("version", "Update available", { local, npm })

        // Update any configs found
        const updated = updateConfigVersion(npm, logger)

        if (updated) {
            await client.tui.showToast({
                body: {
                    title: "DCP: Update available",
                    message: `v${local} → v${npm}\nRestart OpenCode to apply`,
                    variant: "info",
                    duration: 6000
                }
            })
        } else {
            // Config update failed or plugin not found in config, show manual instructions
            await client.tui.showToast({
                body: {
                    title: "DCP: Update available",
                    message: `v${local} → v${npm}\nUpdate opencode.jsonc:\n"${PACKAGE_NAME}@${npm}"`,
                    variant: "info",
                    duration: 8000
                }
            })
        }
    } catch {
        // Silently fail version checks
    }
}
