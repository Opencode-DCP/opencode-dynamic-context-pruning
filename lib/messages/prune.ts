import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../shared-utils"

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
    "[Output removed to save context - information superseded or no longer needed]"
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]"
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]"

export const prune = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    const pruneSet = new Set(state.prune.toolIds)
    
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }

        const parts = Array.isArray(msg.parts) ? msg.parts : []
        
        for (const part of parts) {
            if (part.type !== "tool") {
                continue
            }
            
            if (!pruneSet.has(part.callID)) {
                continue
            }

            const status = part.state.status
            
            // 1. Prune completed tool outputs (except "question" tool)
            if (status === "completed" && part.tool !== "question") {
                part.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT
            }
            
            // 2. Prune question tool inputs
            if (status === "completed" && part.tool === "question") {
                if (part.state.input?.questions !== undefined) {
                    part.state.input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT
                }
            }
            
            // 3. Prune error tool inputs
            if (status === "error") {
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
}
