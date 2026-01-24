import { tool } from "@opencode-ai/plugin"
import type { PruneToolContext } from "./types"
import { executePruneOperation } from "./prune-shared"
import { PruneReason } from "../ui/notification"
import { loadPrompt } from "../prompts"

const DISCARD_TOOL_DESCRIPTION = loadPrompt("discard-tool-spec")

export function createDiscardTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: DISCARD_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe("Numeric IDs as strings from the <prunable-tools> list to discard"),
        },
        async execute(args, toolCtx) {
            const numericIds = args.ids
            const reason = "noise"

            return executePruneOperation(ctx, toolCtx, numericIds, reason, "Discard")
        },
    })
}
