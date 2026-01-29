import { tool } from "@opencode-ai/plugin"
import type { PruneToolContext } from "./types"
import { executePruneOperation } from "./prune-shared"
import { PruneReason } from "../ui/notification"
import { loadPrompt } from "../prompts"

const DISTILL_TOOL_DESCRIPTION = loadPrompt("distill-tool-spec")

export function createDistillTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: DISTILL_TOOL_DESCRIPTION,
        args: {
            ids: tool.schema
                .array(tool.schema.string())
                .min(1)
                .describe("Numeric IDs as strings to distill from the <prunable-tools> list"),
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
                    "Distill tool called without distillation: " + JSON.stringify(args),
                )
                throw new Error(
                    "Missing distillation. You must provide a distillation string for each ID.",
                )
            }

            if (!Array.isArray(args.distillation)) {
                ctx.logger.debug(
                    "Distill tool called with non-array distillation: " + JSON.stringify(args),
                )
                throw new Error(
                    `Invalid distillation format: expected an array of strings, got ${typeof args.distillation}. ` +
                        `Example: distillation: ["summary for id 0", "summary for id 1"]`,
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
                "Distill",
                args.distillation,
            )
        },
    })
}
