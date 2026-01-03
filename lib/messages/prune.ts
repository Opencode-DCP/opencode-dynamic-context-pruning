import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../shared-utils"

const PRUNED_TOOL_INPUT_REPLACEMENT =
    "[content removed to save context, this is not what was written to the file, but a placeholder]"
const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    pruneToolOutputs(state, logger, messages)
    pruneToolInputs(state, logger, messages)
    pruneToolErrors(state, logger, messages)
}

const pruneToolOutputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.tool === "write" || part.tool === "edit") {
                continue
            }
            if (part.state.status === "completed") {
                part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
            }
        }
    }
}

const pruneToolInputs = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.tool !== "write" && part.tool !== "edit") {
                continue
            }
            if (part.state.status !== "completed") {
                continue
            }

            if (part.tool === "write" && part.state.input?.content !== undefined) {
                part.state.input.content = PRUNED_TOOL_INPUT_REPLACEMENT
            }
            if (part.tool === "edit") {
                if (part.state.input?.oldString !== undefined) {
                    part.state.input.oldString = PRUNED_TOOL_INPUT_REPLACEMENT
                }
                if (part.state.input?.newString !== undefined) {
                    part.state.input.newString = PRUNED_TOOL_INPUT_REPLACEMENT
                }
            }
        }
    }
}

const pruneToolErrors = (state: SessionState, logger: Logger, messages: WithParts[]): void => {
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        for (const part of msg.parts) {
            if (part.type !== "tool") {
                continue
            }
            if (!state.prune.toolIds.includes(part.callID)) {
                continue
            }
            if (part.state.status !== "error") {
                continue
            }

            // Prune all string inputs for errored tools
            const input = part.state.input
            if (input && typeof input === "object") {
                for (const key of Object.keys(input)) {
                    if (typeof input[key] === "string") {
                        input[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
                    }
                }
            }
        }
    }
}
