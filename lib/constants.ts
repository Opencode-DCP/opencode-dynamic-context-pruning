/**
 * Centralized constants for the OpenCode Dynamic Context Pruning (DCP) system.
 * This module contains all magic strings, configuration values, and constants
 * used throughout the codebase to improve maintainability and type safety.
 */

// ============================================================================
// TOOL NAMES & PROTECTED TOOLS
// ============================================================================

/**
 * Names of all tools used in the system
 */
export const TOOL_NAMES = {
    DISCARD: "discard",
    EXTRACT: "extract",
    WRITE: "write",
    READ: "read",
    TASK: "task",
    TODO_WRITE: "todowrite",
    TODO_READ: "todoread",
    BATCH: "batch",
    EDIT: "edit",
    PLAN_ENTER: "plan_enter",
    PLAN_EXIT: "plan_exit",
    QUESTION: "question",
} as const;

/**
 * Default list of protected tools that should not be pruned
 */
export const DEFAULT_PROTECTED_TOOLS = [
    TOOL_NAMES.TASK,
    TOOL_NAMES.TODO_WRITE,
    TOOL_NAMES.TODO_READ,
    TOOL_NAMES.DISCARD,
    TOOL_NAMES.EXTRACT,
    TOOL_NAMES.BATCH,
    TOOL_NAMES.WRITE,
    TOOL_NAMES.EDIT,
    TOOL_NAMES.PLAN_ENTER,
    TOOL_NAMES.PLAN_EXIT,
] as const;

// ============================================================================
// FILE PATHS & DIRECTORIES
// ============================================================================

/**
 * File paths and directory constants for the DCP configuration and OpenCode system
 */
export const PATHS = {
    DCP: {
        CONFIG_JSONC: "dcp.jsonc",
        CONFIG_JSON: "dcp.json",
        SCHEMA_URL: "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    },
    OPENCODE: {
        DIR: ".opencode",
        CONFIG_DIR: ".config/opencode",
        LOGS_DIR: "logs",
        DCP_LOGS_DIR: "dcp",
        DAILY_LOGS_DIR: "daily",
    },
    EXTENSIONS: {
        LOG: ".log",
        JSON: ".json",
    },
} as const;

// ============================================================================
// VALIDATION LIMITS
// ============================================================================

/**
 * Various limits and thresholds used for validation and caching
 */
export const LIMITS = {
    CACHE: {
        MAX_TOOL_CACHE_SIZE: 1000,
        MAX_PARAM_SIZE: 10 * 1024, // 10KB
        MAX_PATH_LENGTH: 4096,
        PATTERN_CACHE_SIZE: 100,
    },
    VALIDATION: {
        MAX_PATTERNS: 100,
        MAX_TOOLS: 50,
        MAX_STRING_LENGTH: 1000,
        MAX_TOOL_ID: 10000,
        MAX_LOG_LENGTH: 500,
    },
    PROTECTION: {
        DEFAULT_TURN_PROTECTION_TURNS: 4,
        DEFAULT_NUDGE_FREQUENCY: 10,
    },
} as const;

// ============================================================================
// ERROR MESSAGES & VALIDATION
// ============================================================================

/**
 * Error message templates and validation strings
 */
export const ERRORS = {
    CONFIG: {
        INVALID_KEYS: "Unknown keys",
        TYPE_MISMATCH: (key: string, expected: string, actual: string) => 
            `${key}: expected ${expected}, got ${actual}`,
        EMPTY_OR_INVALID: "Config file is empty or invalid",
        PARSE_FAILED: "Failed to parse config",
        SIZE_EXCEEDED: (key: string, message: string) => `${key}: ${message}`,
    },
    TOOLS: {
        NO_IDS: "No IDs provided",
        NO_NUMERIC_IDS: "No numeric IDs provided. Format: ids: [id1, id2, ...]",
        INVALID_IDS: "Invalid IDs provided. Only use numeric IDs from the <prunable-tools> list.",
        NO_REASON: "No valid reason found. Use 'completion' or 'noise' as the first element.",
        NO_DISTILLATION: "Missing distillation. You must provide a distillation string for each ID.",
    },
    DCP: {
        INVALID_CONFIG: (configType: string) => `DCP: Invalid ${configType}`,
        VALIDATION_FAILED: "DCP config validation failed",
    },
} as const;

// ============================================================================
// LOG FORMAT STRINGS
// ============================================================================

/**
 * Logging format constants and patterns
 */
export const LOG_FORMATS = {
    LEVELS: ["INFO", "DEBUG", "WARN", "ERROR"],
    COMPONENT_PATTERN: /([^/\\]+)\.[tj]s$/,
    DATE_FORMAT: "YYYY-MM-DD",
    TIMESTAMP_PATTERN: /[:.]/g,
} as const;

// ============================================================================
// COMMAND NAMES & SPECIAL STRINGS
// ============================================================================

/**
 * Command names and special string constants used throughout the system
 */
export const COMMANDS = {
    NAME: "dcp",
    HANDLED_COMPLETED: "__DCP_COMPLETED_HANDLED__",
    HANDLED_CONTEXT: "__DCP_CONTEXT_HANDLED__",
    HANDLED_STATS: "__DCP_STATS_HANDLED__",
    HANDLED_SWEEP: "__DCP_SWEEP_HANDLED__",
    HANDLED_HELP: "__DCP_HELP_HANDLED__",
} as const;

/**
 * Signatures used to identify internal agents
 */
export const INTERNAL_AGENT_SIGNATURES = [
    "You are a title generator",
    "You are a helpful AI assistant tasked with summarizing conversations",
    "Summarize what was done in this conversation",
] as const;

// ============================================================================
// UI & DISPLAY STRINGS
// ============================================================================

/**
 * UI strings and display messages for user feedback
 */
export const UI = {
    PRUNED: {
        TOOL_OUTPUT: "[Output removed to save context - information superseded or not needed]",
        TOOL_ERROR_INPUT: "[input removed due to failed tool call]",
        QUESTION_INPUT: "[questions removed - see output for user's answers]",
    },
    COOLDOWN: {
        HEADER: "<!-- prunable-tools [COOLDOWN] -->",
        MESSAGE: (toolName: string) => 
            `<!-- ${toolName} tool used recently. See <prunable-tools> for fresh list. -->`,
    },
} as const;

// ============================================================================
// TOOL STATUS VALUES
// ============================================================================

/**
 * Status values for tool execution and pruning
 */
export const TOOL_STATUS = {
    PENDING: "pending",
    RUNNING: "running",
    COMPLETED: "completed",
    ERROR: "error",
} as const;

/**
 * Valid reasons for pruning tools
 */
export const PRUNE_REASONS = {
    COMPLETION: "completion",
    NOISE: "noise",
    EXTRACTION: "extraction",
} as const;