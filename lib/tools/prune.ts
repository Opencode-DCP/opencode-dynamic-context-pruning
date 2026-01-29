import { tool } from "@opencode-ai/plugin"
import type { PruneToolContext } from "./types"
import { executePruneOperation } from "./prune-shared"
import { PruneReason } from "../ui/notification"
import { loadPrompt } from "../prompts"

const PRUNE_TOOL_DESCRIPTION = loadPrompt("prune-tool-spec")

export function createPruneTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: PRUNE_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe("Numeric IDs as strings from the <prunable-tools> list to prune"),
        },
        async execute(args, toolCtx) {
            const numericIds = args.ids
            const reason = "noise"

            return executePruneOperation(ctx, toolCtx, numericIds, reason, "Prune")
        },
    })
}
