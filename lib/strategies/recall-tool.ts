import { tool } from "@opencode-ai/plugin"
import type { SessionState } from "../state"
import type { Logger } from "../logger"
import { loadPrompt } from "../prompt"

/** Tool description loaded from prompts/recall-tool.txt */
const TOOL_DESCRIPTION = loadPrompt("recall-tool")

export interface RecallToolContext {
    state: SessionState
    logger: Logger
}

/**
 * Creates the recall tool definition.
 * Allows the LLM to pause and reflect on current progress and understanding.
 */
export function createRecallTool(
    ctx: RecallToolContext,
): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: {
            summary: tool.schema.string().describe(
                "Your structured self-assessment including: task understanding (key facts, assumptions, gaps, connections), progress evaluation (completed milestones, viable paths forward), and next steps"
            ),
        },
        async execute(args, _toolCtx) {
            const { state, logger } = ctx

            // Reset recall counter when recall is explicitly called
            state.recallCounter = 0
            
            logger.debug("Recall tool executed with summary:", args.summary?.substring(0, 100))

            return "Recall completed. Continue with your work."
        },
    })
}
