import type { CompressionLearningConfig } from "../../config"

const DURABLE_LEARNING_CRITERIA = `Extract only new, non-obvious, durable codebase knowledge:

- hidden relationships between files or modules;
- execution paths that differ from how the code appears;
- non-obvious configuration, environment variables, or flags;
- debugging breakthroughs when errors were misleading;
- API or tool quirks and their workarounds;
- useful build or test commands not already documented;
- architectural decisions and constraints;
- files that must change together.

Do not treat obvious documented facts, standard language or framework behavior, existing repository guidance, verbose explanations, or session-specific details as durable learning.`

function renderNotificationInstructions(): string {
    return `Before starting the learning pass, send the user this exact progress message:

\`Initialized pre-compression learning.\`

After the learning pass, send one concise progress message before invoking the compress tool:

- If durable learning was found, start with \`Learning is finished.\` and briefly list the insights and any files changed.
- If there was no durable learning, send exactly \`Learning is finished. Nothing to extract.\`

These messages must not interrupt compression or ask the user for input.`
}

export function appendCompressionLearning(
    prompt: string,
    config?: CompressionLearningConfig,
): string {
    if (!config?.enabled) {
        return prompt
    }

    const sections = [
        prompt.trim(),
        `LEARN BEFORE COMPRESSION

Before invoking the compress tool, review the selected closed context for durable codebase learning.

First follow any learning policy present in the system or project instructions. Read the applicable repository guidance before deciding what to extract or where to persist it. Treat the criteria below as defaults where project policy is silent; do not override more specific project learning rules.

${DURABLE_LEARNING_CRITERIA}

When genuine new learning exists, determine its narrowest applicable directory and follow the project's persistence policy. If the project does not specify a destination, read the relevant existing AGENTS.md files and persist each insight in 1-3 concise lines in the nearest appropriate AGENTS.md before compressing. Do not create or edit guidance files when there is no durable new learning.

Do not manufacture learning or delay necessary compression. The compression summary must still preserve all session state needed to continue; persisted guidance complements rather than replaces that summary.`,
    ]

    if (config.notifications) {
        sections.push(renderNotificationInstructions())
    }

    return sections.join("\n\n")
}
