import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import { isMessageCompacted } from "../shared-utils"
import { UI } from "../constants"

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
                part.state.output = UI.PRUNED.TOOL_OUTPUT
            }
            
            // 2. Prune question tool inputs
            if (status === "completed" && part.tool === "question") {
                if (part.state.input?.questions !== undefined) {
                    part.state.input.questions = UI.PRUNED.QUESTION_INPUT
                }
            }
            
            // 3. Prune error tool inputs
            if (status === "error") {
                const input = part.state.input
                if (input && typeof input === "object") {
                    for (const key of Object.keys(input)) {
                        if (typeof input[key] === "string") {
                            input[key] = UI.PRUNED.TOOL_ERROR_INPUT
                        }
                    }
                }
            }
        }
    }
}
