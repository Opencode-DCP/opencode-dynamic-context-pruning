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
                .describe("Numeric IDs as strings to distill from the <prunable-tools> list"),
            distillation: tool.schema
                .array(tool.schema.string())
                .describe(
                    "Required array of distillation strings, one per ID (positional: distillation[0] for ids[0], etc.)",
                ),
        },
        async execute(args, toolCtx) {
            if (!args.ids || !Array.isArray(args.ids) || args.ids.length === 0) {
                ctx.logger.debug("Distill tool called without ids: " + JSON.stringify(args))
                throw new Error("Missing ids. You must provide at least one ID to distill.")
            }

            if (!args.ids.every((id) => typeof id === "string" && id.trim() !== "")) {
                ctx.logger.debug("Distill tool called with invalid ids: " + JSON.stringify(args))
                throw new Error(
                    'Invalid ids. All IDs must be numeric strings (e.g., "1", "23") from the <prunable-tools> list.',
                )
            }

            if (
                !args.distillation ||
                !Array.isArray(args.distillation) ||
                args.distillation.length === 0
            ) {
                ctx.logger.debug(
                    "Distill tool called without distillation: " + JSON.stringify(args),
                )
                throw new Error(
                    'Missing distillation. You must provide an array of strings (e.g., ["summary 1", "summary 2"]).',
                )
            }

            if (!args.distillation.every((d) => typeof d === "string")) {
                ctx.logger.debug(
                    "Distill tool called with non-string distillation: " + JSON.stringify(args),
                )
                throw new Error("Invalid distillation. All distillation entries must be strings.")
            }

            // ctx.logger.info("Distillation data received:")
            // ctx.logger.info(JSON.stringify(args.distillation, null, 2))

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
