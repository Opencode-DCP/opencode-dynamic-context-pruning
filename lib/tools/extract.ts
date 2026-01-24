import { tool } from "@opencode-ai/plugin"
import type { PruneToolContext } from "./types"
import { executePruneOperation } from "./prune-shared"
import { PruneReason } from "../ui/notification"
import { loadPrompt } from "../prompts"

const EXTRACT_TOOL_DESCRIPTION = loadPrompt("extract-tool-spec")

export function createExtractTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: EXTRACT_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe("Numeric IDs as strings to extract from the <prunable-tools> list"),
            distillation: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe(
                    "Required array of distillation strings, one per ID (positional: distillation[0] for ids[0], etc.)",
                ),
        },
        async execute(args, toolCtx) {
            if (!args.distillation || args.distillation.length === 0) {
                ctx.logger.debug(
                    "Extract tool called without distillation: " + JSON.stringify(args),
                )
                throw new Error(
                    "Missing distillation. You must provide a distillation string for each ID.",
                )
            }

            // Log the distillation for debugging/analysis
            ctx.logger.info("Distillation data received:")
            ctx.logger.info(JSON.stringify(args.distillation, null, 2))

            return executePruneOperation(
                ctx,
                toolCtx,
                args.ids,
                "extraction" as PruneReason,
                "Extract",
                args.distillation,
            )
        },
    })
}
