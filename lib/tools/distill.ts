import { tool } from "@opencode-ai/plugin"
import type { PruneToolContext } from "./types"
import { executePruneOperation } from "./prune-shared"
import { PruneReason } from "../ui/notification"
import { loadPrompt } from "../prompts"

const DISTILL_TOOL_DESCRIPTION = loadPrompt("distill-tool-spec")

/**
 * Creates a tool for distilling key findings from tool outputs.
 *
 * This tool allows LLMs to preserve valuable information from large or
 * complex tool outputs while removing the raw content to save context.
 *
 * @param ctx - The prune tool context containing logger and state
 * @returns A configured tool instance for the OpenCode plugin
 */
export function createDistillTool(ctx: PruneToolContext): ReturnType<typeof tool> {
    return tool({
        description: DISTILL_TOOL_DESCRIPTION,
        args: {
            items: tool.schema
                .array(
                    tool.schema.object({
                        id: tool.schema.string().describe("Numeric ID as string from <prunable-tools> list"),
                        distillation: tool.schema
                            .string()
                            .describe("String capturing essential information to preserve"),
                    }),
                )
                .describe("Array of objects, each containing id and distillation"),
        },
        async execute(args, toolCtx) {
            if (!args.items || !Array.isArray(args.items) || args.items.length === 0) {
                ctx.logger.debug("Distill tool called without items: " + JSON.stringify(args))
                throw new Error(
                    "Missing items. You must provide at least one item to distill.",
                )
            }

            const ids: string[] = []
            const distillations: string[] = []

            for (const item of args.items) {
                if (!item.id || typeof item.id !== "string" || item.id.trim() === "") {
                    ctx.logger.debug("Distill tool called with invalid id: " + JSON.stringify(args))
                    throw new Error(
                        'Invalid id. All ids must be numeric strings (e.g., "1", "23") from the <prunable-tools> list.',
                    )
                }

                if (!item.distillation || typeof item.distillation !== "string") {
                    ctx.logger.debug("Distill tool called with invalid distillation: " + JSON.stringify(args))
                    throw new Error("Invalid distillation. All distillation entries must be strings.")
                }

                ids.push(item.id)
                distillations.push(item.distillation)
            }

            return executePruneOperation(
                ctx,
                toolCtx,
                ids,
                "extraction" as PruneReason,
                "Distill",
                distillations,
            )
        },
    })
}
