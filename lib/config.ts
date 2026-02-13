import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser"
import type { PluginInput } from "@opencode-ai/plugin"

type Permission = "ask" | "allow" | "deny"

export interface Deduplication {
    enabled: boolean
    protectedTools: string[]
}

export interface CompressTool {
    permission: Permission
    showCompression: boolean
}

export interface ToolSettings {
    limitNudgeInterval: number
    protectedTools: string[]
    contextLimit: number | `${number}%`
    modelLimits?: Record<string, number | `${number}%`>
}

export interface Tools {
    settings: ToolSettings
    compress: CompressTool
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface SupersedeWrites {
    enabled: boolean
}

export interface PurgeErrors {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface TurnProtection {
    enabled: boolean
    turns: number
}

export interface PluginConfig {
    enabled: boolean
    debug: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    manualMode: ManualModeConfig
    turnProtection: TurnProtection
    protectedFilePatterns: string[]
    tools: Tools
    strategies: {
        deduplication: Deduplication
        supersedeWrites: SupersedeWrites
        purgeErrors: PurgeErrors
    }
}

type ToolOverride = Partial<Tools>

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "todowrite",
    "todoread",
    "compress",
    "batch",
    "plan_enter",
    "plan_exit",
]

export const VALID_CONFIG_KEYS = new Set([
    "$schema",
    "enabled",
    "debug",
    "showUpdateToasts",
    "pruneNotification",
    "pruneNotificationType",
    "turnProtection",
    "turnProtection.enabled",
    "turnProtection.turns",
    "protectedFilePatterns",
    "commands",
    "commands.enabled",
    "commands.protectedTools",
    "manualMode",
    "manualMode.enabled",
    "manualMode.automaticStrategies",
    "tools",
    "tools.settings",
    "tools.settings.limitNudgeInterval",
    "tools.settings.protectedTools",
    "tools.settings.contextLimit",
    "tools.settings.modelLimits",
    "tools.compress",
    "tools.compress.permission",
    "tools.compress.showCompression",
    "strategies",
    "strategies.deduplication",
    "strategies.deduplication.enabled",
    "strategies.deduplication.protectedTools",
    "strategies.supersedeWrites",
    "strategies.supersedeWrites.enabled",
    "strategies.purgeErrors",
    "strategies.purgeErrors.enabled",
    "strategies.purgeErrors.turns",
    "strategies.purgeErrors.protectedTools",
])

function getConfigKeyPaths(obj: Record<string, any>, prefix = ""): string[] {
    const keys: string[] = []
    for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key
        keys.push(fullKey)

        // modelLimits is a dynamic map keyed by providerID/modelID; do not recurse into arbitrary IDs.
        if (fullKey === "tools.settings.modelLimits") {
            continue
        }

        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
            keys.push(...getConfigKeyPaths(obj[key], fullKey))
        }
    }
    return keys
}

export function getInvalidConfigKeys(userConfig: Record<string, any>): string[] {
    const userKeys = getConfigKeyPaths(userConfig)
    return userKeys.filter((key) => !VALID_CONFIG_KEYS.has(key))
}

interface ValidationError {
    key: string
    expected: string
    actual: string
}

export function validateConfigTypes(config: Record<string, any>): ValidationError[] {
    const errors: ValidationError[] = []

    if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
        errors.push({ key: "enabled", expected: "boolean", actual: typeof config.enabled })
    }

    if (config.debug !== undefined && typeof config.debug !== "boolean") {
        errors.push({ key: "debug", expected: "boolean", actual: typeof config.debug })
    }

    if (config.pruneNotification !== undefined) {
        const validValues = ["off", "minimal", "detailed"]
        if (!validValues.includes(config.pruneNotification)) {
            errors.push({
                key: "pruneNotification",
                expected: '"off" | "minimal" | "detailed"',
                actual: JSON.stringify(config.pruneNotification),
            })
        }
    }

    if (config.pruneNotificationType !== undefined) {
        const validValues = ["chat", "toast"]
        if (!validValues.includes(config.pruneNotificationType)) {
            errors.push({
                key: "pruneNotificationType",
                expected: '"chat" | "toast"',
                actual: JSON.stringify(config.pruneNotificationType),
            })
        }
    }

    if (config.protectedFilePatterns !== undefined) {
        if (!Array.isArray(config.protectedFilePatterns)) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: typeof config.protectedFilePatterns,
            })
        } else if (!config.protectedFilePatterns.every((v: unknown) => typeof v === "string")) {
            errors.push({
                key: "protectedFilePatterns",
                expected: "string[]",
                actual: "non-string entries",
            })
        }
    }

    if (config.turnProtection) {
        if (
            config.turnProtection.enabled !== undefined &&
            typeof config.turnProtection.enabled !== "boolean"
        ) {
            errors.push({
                key: "turnProtection.enabled",
                expected: "boolean",
                actual: typeof config.turnProtection.enabled,
            })
        }

        if (
            config.turnProtection.turns !== undefined &&
            typeof config.turnProtection.turns !== "number"
        ) {
            errors.push({
                key: "turnProtection.turns",
                expected: "number",
                actual: typeof config.turnProtection.turns,
            })
        }
    }

    const commands = config.commands
    if (commands !== undefined) {
        if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
            errors.push({
                key: "commands",
                expected: "object",
                actual: typeof commands,
            })
        } else {
            if (commands.enabled !== undefined && typeof commands.enabled !== "boolean") {
                errors.push({
                    key: "commands.enabled",
                    expected: "boolean",
                    actual: typeof commands.enabled,
                })
            }
            if (commands.protectedTools !== undefined && !Array.isArray(commands.protectedTools)) {
                errors.push({
                    key: "commands.protectedTools",
                    expected: "string[]",
                    actual: typeof commands.protectedTools,
                })
            }
        }
    }

    const manualMode = config.manualMode
    if (manualMode !== undefined) {
        if (typeof manualMode !== "object" || manualMode === null || Array.isArray(manualMode)) {
            errors.push({
                key: "manualMode",
                expected: "object",
                actual: typeof manualMode,
            })
        } else {
            if (manualMode.enabled !== undefined && typeof manualMode.enabled !== "boolean") {
                errors.push({
                    key: "manualMode.enabled",
                    expected: "boolean",
                    actual: typeof manualMode.enabled,
                })
            }

            if (
                manualMode.automaticStrategies !== undefined &&
                typeof manualMode.automaticStrategies !== "boolean"
            ) {
                errors.push({
                    key: "manualMode.automaticStrategies",
                    expected: "boolean",
                    actual: typeof manualMode.automaticStrategies,
                })
            }
        }
    }

    const tools = config.tools
    if (tools) {
        if (tools.settings) {
            if (
                tools.settings.limitNudgeInterval !== undefined &&
                typeof tools.settings.limitNudgeInterval !== "number"
            ) {
                errors.push({
                    key: "tools.settings.limitNudgeInterval",
                    expected: "number",
                    actual: typeof tools.settings.limitNudgeInterval,
                })
            }

            if (
                tools.settings.protectedTools !== undefined &&
                !Array.isArray(tools.settings.protectedTools)
            ) {
                errors.push({
                    key: "tools.settings.protectedTools",
                    expected: "string[]",
                    actual: typeof tools.settings.protectedTools,
                })
            }

            if (tools.settings.contextLimit !== undefined) {
                const isValidNumber = typeof tools.settings.contextLimit === "number"
                const isPercentString =
                    typeof tools.settings.contextLimit === "string" &&
                    tools.settings.contextLimit.endsWith("%")

                if (!isValidNumber && !isPercentString) {
                    errors.push({
                        key: "tools.settings.contextLimit",
                        expected: 'number | "${number}%"',
                        actual: JSON.stringify(tools.settings.contextLimit),
                    })
                }
            }

            if (tools.settings.modelLimits !== undefined) {
                if (
                    typeof tools.settings.modelLimits !== "object" ||
                    tools.settings.modelLimits === null ||
                    Array.isArray(tools.settings.modelLimits)
                ) {
                    errors.push({
                        key: "tools.settings.modelLimits",
                        expected: "Record<string, number | ${number}%>",
                        actual: typeof tools.settings.modelLimits,
                    })
                } else {
                    for (const [providerModelKey, limit] of Object.entries(
                        tools.settings.modelLimits,
                    )) {
                        const isValidNumber = typeof limit === "number"
                        const isPercentString =
                            typeof limit === "string" && /^\d+(?:\.\d+)?%$/.test(limit)
                        if (!isValidNumber && !isPercentString) {
                            errors.push({
                                key: `tools.settings.modelLimits.${providerModelKey}`,
                                expected: 'number | "${number}%"',
                                actual: JSON.stringify(limit),
                            })
                        }
                    }
                }
            }
        }

        if (tools.compress) {
            const validValues = ["ask", "allow", "deny"]
            if (
                tools.compress.permission !== undefined &&
                !validValues.includes(tools.compress.permission)
            ) {
                errors.push({
                    key: "tools.compress.permission",
                    expected: '"ask" | "allow" | "deny"',
                    actual: JSON.stringify(tools.compress.permission),
                })
            }

            if (
                tools.compress.showCompression !== undefined &&
                typeof tools.compress.showCompression !== "boolean"
            ) {
                errors.push({
                    key: "tools.compress.showCompression",
                    expected: "boolean",
                    actual: typeof tools.compress.showCompression,
                })
            }
        }
    }

    const strategies = config.strategies
    if (strategies) {
        if (
            strategies.deduplication?.enabled !== undefined &&
            typeof strategies.deduplication.enabled !== "boolean"
        ) {
            errors.push({
                key: "strategies.deduplication.enabled",
                expected: "boolean",
                actual: typeof strategies.deduplication.enabled,
            })
        }

        if (
            strategies.deduplication?.protectedTools !== undefined &&
            !Array.isArray(strategies.deduplication.protectedTools)
        ) {
            errors.push({
                key: "strategies.deduplication.protectedTools",
                expected: "string[]",
                actual: typeof strategies.deduplication.protectedTools,
            })
        }

        if (strategies.supersedeWrites) {
            if (
                strategies.supersedeWrites.enabled !== undefined &&
                typeof strategies.supersedeWrites.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.supersedeWrites.enabled",
                    expected: "boolean",
                    actual: typeof strategies.supersedeWrites.enabled,
                })
            }
        }

        if (strategies.purgeErrors) {
            if (
                strategies.purgeErrors.enabled !== undefined &&
                typeof strategies.purgeErrors.enabled !== "boolean"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.enabled",
                    expected: "boolean",
                    actual: typeof strategies.purgeErrors.enabled,
                })
            }

            if (
                strategies.purgeErrors.turns !== undefined &&
                typeof strategies.purgeErrors.turns !== "number"
            ) {
                errors.push({
                    key: "strategies.purgeErrors.turns",
                    expected: "number",
                    actual: typeof strategies.purgeErrors.turns,
                })
            }

            if (
                strategies.purgeErrors.protectedTools !== undefined &&
                !Array.isArray(strategies.purgeErrors.protectedTools)
            ) {
                errors.push({
                    key: "strategies.purgeErrors.protectedTools",
                    expected: "string[]",
                    actual: typeof strategies.purgeErrors.protectedTools,
                })
            }
        }
    }

    return errors
}

function showConfigValidationWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `DCP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    debug: false,
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    protectedFilePatterns: [],
    tools: {
        settings: {
            limitNudgeInterval: 1,
            protectedTools: [...DEFAULT_PROTECTED_TOOLS],
            contextLimit: 100000,
        },
        compress: {
            permission: "allow",
            showCompression: false,
        },
    },
    strategies: {
        deduplication: {
            enabled: true,
            protectedTools: [],
        },
        supersedeWrites: {
            enabled: true,
        },
        purgeErrors: {
            enabled: true,
            turns: 4,
            protectedTools: [],
        },
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "dcp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "dcp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const global = existsSync(GLOBAL_CONFIG_PATH_JSONC)
        ? GLOBAL_CONFIG_PATH_JSONC
        : existsSync(GLOBAL_CONFIG_PATH_JSON)
          ? GLOBAL_CONFIG_PATH_JSON
          : null

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "dcp.jsonc")
        const configJson = join(opencodeConfigDir, "dcp.json")
        configDir = existsSync(configJsonc)
            ? configJsonc
            : existsSync(configJson)
              ? configJson
              : null
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "dcp.jsonc")
            const projectJson = join(opencodeDir, "dcp.json")
            project = existsSync(projectJsonc)
                ? projectJsonc
                : existsSync(projectJson)
                  ? projectJson
                  : null
        }
    }

    return { global, configDir, project }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    const configContent = `{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json"
}
`
    writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

function mergeStrategies(
    base: PluginConfig["strategies"],
    override?: Partial<PluginConfig["strategies"]>,
): PluginConfig["strategies"] {
    if (!override) {
        return base
    }

    return {
        deduplication: {
            enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
            protectedTools: [
                ...new Set([
                    ...base.deduplication.protectedTools,
                    ...(override.deduplication?.protectedTools ?? []),
                ]),
            ],
        },
        supersedeWrites: {
            enabled: override.supersedeWrites?.enabled ?? base.supersedeWrites.enabled,
        },
        purgeErrors: {
            enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
            turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
            protectedTools: [
                ...new Set([
                    ...base.purgeErrors.protectedTools,
                    ...(override.purgeErrors?.protectedTools ?? []),
                ]),
            ],
        },
    }
}

function mergeTools(base: PluginConfig["tools"], override?: ToolOverride): PluginConfig["tools"] {
    if (!override) {
        return base
    }

    return {
        settings: {
            limitNudgeInterval:
                override.settings?.limitNudgeInterval ?? base.settings.limitNudgeInterval,
            protectedTools: [
                ...new Set([
                    ...base.settings.protectedTools,
                    ...(override.settings?.protectedTools ?? []),
                ]),
            ],
            contextLimit: override.settings?.contextLimit ?? base.settings.contextLimit,
            modelLimits: override.settings?.modelLimits ?? base.settings.modelLimits,
        },
        compress: {
            permission: override.compress?.permission ?? base.compress.permission,
            showCompression: override.compress?.showCompression ?? base.compress.showCompression,
        },
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) {
        return base
    }

    return {
        enabled: override.enabled ?? base.enabled,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
    }
}

function mergeManualMode(
    base: PluginConfig["manualMode"],
    override?: Partial<PluginConfig["manualMode"]>,
): PluginConfig["manualMode"] {
    if (override === undefined) return base

    return {
        enabled: override.enabled ?? base.enabled,
        automaticStrategies: override.automaticStrategies ?? base.automaticStrategies,
    }
}

function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        manualMode: {
            enabled: config.manualMode.enabled,
            automaticStrategies: config.manualMode.automaticStrategies,
        },
        turnProtection: { ...config.turnProtection },
        protectedFilePatterns: [...config.protectedFilePatterns],
        tools: {
            settings: {
                ...config.tools.settings,
                protectedTools: [...config.tools.settings.protectedTools],
                modelLimits: { ...config.tools.settings.modelLimits },
            },
            compress: { ...config.tools.compress },
        },
        strategies: {
            deduplication: {
                ...config.strategies.deduplication,
                protectedTools: [...config.strategies.deduplication.protectedTools],
            },
            supersedeWrites: { ...config.strategies.supersedeWrites },
            purgeErrors: {
                ...config.strategies.purgeErrors,
                protectedTools: [...config.strategies.purgeErrors.protectedTools],
            },
        },
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        debug: data.debug ?? config.debug,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
        commands: mergeCommands(config.commands, data.commands as any),
        manualMode: mergeManualMode(config.manualMode, data.manualMode as any),
        turnProtection: {
            enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
            turns: data.turnProtection?.turns ?? config.turnProtection.turns,
        },
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        tools: mergeTools(config.tools, data.tools as ToolOverride),
        strategies: mergeStrategies(config.strategies, data.strategies as any),
    }
}

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `DCP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigValidationWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    return config
}
