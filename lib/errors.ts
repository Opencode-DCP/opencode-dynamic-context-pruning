/**
 * Custom error classes for DCP plugin.
 * Used for control flow in command handling to avoid magic string comparisons.
 */

/**
 * Base class for DCP command handling errors.
 * These are thrown to signal that a command was handled and no further processing is needed.
 */
export class DCPCommandHandledError extends Error {
    constructor(message: string = "DCP command handled") {
        super(message)
        this.name = "DCPCommandHandledError"
    }
}

/**
 * Specific error types for different command outcomes.
 */
export class DCPContextHandledError extends DCPCommandHandledError {
    constructor() {
        super("Context command handled")
        this.name = "DCPContextHandledError"
    }
}

export class DCPStatsHandledError extends DCPCommandHandledError {
    constructor() {
        super("Stats command handled")
        this.name = "DCPStatsHandledError"
    }
}

export class DCPSweepHandledError extends DCPCommandHandledError {
    constructor() {
        super("Sweep command handled")
        this.name = "DCPSweepHandledError"
    }
}

export class DCPManualHandledError extends DCPCommandHandledError {
    constructor() {
        super("Manual command handled")
        this.name = "DCPManualHandledError"
    }
}

export class DCPManualTriggerBlockedError extends DCPCommandHandledError {
    constructor() {
        super("Manual trigger blocked")
        this.name = "DCPManualTriggerBlockedError"
    }
}

export class DCPHelpHandledError extends DCPCommandHandledError {
    constructor() {
        super("Help command handled")
        this.name = "DCPHelpHandledError"
    }
}

/**
 * Type guard to check if an error is a DCP command handled error.
 */
export function isDCPCommandHandledError(error: unknown): error is DCPCommandHandledError {
    return error instanceof DCPCommandHandledError
}
