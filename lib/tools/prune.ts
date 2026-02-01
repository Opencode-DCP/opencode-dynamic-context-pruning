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
                .describe("Numeric IDs as strings from the <prunable-tools> list to prune"),
        },
        async execute(args, toolCtx) {
            if (!args.ids || !Array.isArray(args.ids) || args.ids.length === 0) {
                ctx.logger.debug("Prune tool called without ids: " + JSON.stringify(args))
                throw new Error("Missing ids. You must provide at least one ID to prune.")
            }

            if (!args.ids.every((id) => typeof id === "string" && id.trim() !== "")) {
                ctx.logger.debug("Prune tool called with invalid ids: " + JSON.stringify(args))
                throw new Error(
                    'Invalid ids. All IDs must be numeric strings (e.g., "1", "23") from the <prunable-tools> list.',
                )
            }

            const numericIds = args.ids
            const reason = "noise"

            return executePruneOperation(ctx, toolCtx, numericIds, reason, "Prune")
        },
    })
}
