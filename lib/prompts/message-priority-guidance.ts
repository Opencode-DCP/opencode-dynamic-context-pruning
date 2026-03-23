export function renderMessagePriorityGuidance(priorityLabel: string, refs: string[]): string {
    const refList = refs.length > 0 ? refs.join(", ") : "none"

    return [
        "Message priority context:",
        "- Higher-priority older messages consume more context and should be compressed before lower-priority ones when safely closed.",
        `- ${priorityLabel}-priority message IDs before this point: ${refList}`,
    ].join("\n")
}
