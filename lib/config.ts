// lib/config.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parse } from 'jsonc-parser'
import { Logger } from './logger'

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    protectedTools: string[]
    model?: string // Format: "provider/model" (e.g., "anthropic/claude-haiku-4-5")
}

const defaultConfig: PluginConfig = {
    enabled: true, // Plugin is enabled by default
    debug: false, // Disable debug logging by default
    protectedTools: ['task'] // Tools that should never be pruned
}

const CONFIG_DIR = join(homedir(), '.config', 'opencode')
const CONFIG_PATH_JSONC = join(CONFIG_DIR, 'dcp.jsonc')
const CONFIG_PATH_JSON = join(CONFIG_DIR, 'dcp.json')

/**
 * Determines which config file to use (prefers .jsonc, falls back to .json)
 */
function getConfigPath(): string {
    if (existsSync(CONFIG_PATH_JSONC)) {
        return CONFIG_PATH_JSONC
    }
    if (existsSync(CONFIG_PATH_JSON)) {
        return CONFIG_PATH_JSON
    }
    // Default to .jsonc for new installations (supports comments)
    return CONFIG_PATH_JSONC
}

/**
 * Creates the default configuration file with helpful comments
 */
function createDefaultConfig(): void {
    // Ensure the directory exists
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  // Enable or disable the Dynamic Context Pruning plugin
  "enabled": true,

  // Enable debug logging to ~/.config/opencode/logs/dcp/YYYY-MM-DD.log
  "debug": false,

  // Optional: Specify a model to use for analysis instead of the session model
  // Format: "provider/model" (same as agent model config in opencode.jsonc)
  // NOTE: Anthropic OAuth sonnet 4+ tier models are currently not supported
  // "model": "anthropic/claude-haiku-4-5",

  // List of tools that should never be pruned from context
  // The 'task' tool is protected by default to preserve subagent coordination
  "protectedTools": ["task"]
}
`

    writeFileSync(CONFIG_PATH_JSONC, configContent, 'utf-8')
}

/**
 * Loads configuration from ~/.config/opencode/dcp.jsonc or dcp.json
 * Creates the file with defaults if it doesn't exist
 * Supports both JSON and JSONC (JSON with Comments) formats
 */
export function getConfig(): PluginConfig {
    const configPath = getConfigPath()

    // Create default config if neither file exists
    if (!existsSync(configPath)) {
        createDefaultConfig()
    }

    try {
        const fileContent = readFileSync(configPath, 'utf-8')
        // jsonc-parser handles both JSON and JSONC formats
        const userConfig = parse(fileContent) as Partial<PluginConfig>

        // Merge user config with defaults (user config takes precedence)
        return {
            enabled: userConfig.enabled ?? defaultConfig.enabled,
            debug: userConfig.debug ?? defaultConfig.debug,
            protectedTools: userConfig.protectedTools ?? defaultConfig.protectedTools,
            model: userConfig.model
        }
    } catch (error: any) {
        // Log errors to file (always enabled for config errors)
        const logger = new Logger(true)
        logger.error('config', `Failed to read config from ${configPath}: ${error.message}`)
        logger.error('config', 'Using default configuration')
        return defaultConfig
    }
}
