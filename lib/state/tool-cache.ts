import type { PluginState } from "./index"
import type { Logger } from "../logger"

/**
 * Cache tool parameters from OpenAI Chat Completions and Anthropic style messages.
 * Extracts tool call IDs and their parameters from assistant messages.
 * 
 * Supports:
 * - OpenAI format: message.tool_calls[] with id, function.name, function.arguments
 * - Anthropic format: message.content[] with type='tool_use', id, name, input
 */
export function cacheToolParametersFromMessages(
    messages: any[],
    state: PluginState,
    logger?: Logger
): void {
    let openaiCached = 0
    let anthropicCached = 0

    for (const message of messages) {
        if (message.role !== 'assistant') {
            continue
        }

        // OpenAI format: tool_calls array
        if (Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                if (!toolCall.id || !toolCall.function) {
                    continue
                }

                try {
                    const params = typeof toolCall.function.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : toolCall.function.arguments
                    state.toolParameters.set(toolCall.id, {
                        tool: toolCall.function.name,
                        parameters: params
                    })
                    openaiCached++
                } catch (error) {
                    // Silently ignore parse errors
                }
            }
        }

        // Anthropic format: content array with tool_use blocks
        if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type !== 'tool_use' || !part.id || !part.name) {
                    continue
                }

                state.toolParameters.set(part.id, {
                    tool: part.name,
                    parameters: part.input ?? {}
                })
                anthropicCached++
            }
        }
    }

    // Log cache results if anything was cached
    if (logger && (openaiCached > 0 || anthropicCached > 0)) {
        logger.debug("tool-cache", "Cached tool parameters from messages", {
            openaiFormat: openaiCached,
            anthropicFormat: anthropicCached,
            totalCached: state.toolParameters.size
        })
    }
}

/**
 * Cache tool parameters from OpenAI Responses API format.
 * Extracts from input array items with type='function_call'.
 */
export function cacheToolParametersFromInput(
    input: any[],
    state: PluginState,
    logger?: Logger
): void {
    let cached = 0

    for (const item of input) {
        if (item.type !== 'function_call' || !item.call_id || !item.name) {
            continue
        }

        try {
            const params = typeof item.arguments === 'string'
                ? JSON.parse(item.arguments)
                : item.arguments
            state.toolParameters.set(item.call_id, {
                tool: item.name,
                parameters: params
            })
            cached++
        } catch (error) {
            // Silently ignore parse errors
        }
    }

    if (logger && cached > 0) {
        logger.debug("tool-cache", "Cached tool parameters from input", {
            responsesApiFormat: cached,
            totalCached: state.toolParameters.size
        })
    }
}

/** Maximum number of entries to keep in the tool parameters cache */
const MAX_TOOL_CACHE_SIZE = 500

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
export function trimToolParametersCache(state: PluginState): void {
    if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
        return
    }

    const keysToRemove = Array.from(state.toolParameters.keys())
        .slice(0, state.toolParameters.size - MAX_TOOL_CACHE_SIZE)

    for (const key of keysToRemove) {
        state.toolParameters.delete(key)
    }
}
