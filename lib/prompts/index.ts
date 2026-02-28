import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated"

function stripConditionalTag(content: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>[\\s\\S]*?</${tagName}>`, "g")
    return content.replace(regex, "")
}

export function renderSystemPrompt(manual?: boolean, subagent?: boolean): string {
    let result = SYSTEM_PROMPT
    result = result.replace(/\/\/.*?\/\//g, "")

    if (!manual) {
        result = stripConditionalTag(result, "manual")
    }

    if (!subagent) {
        result = stripConditionalTag(result, "subagent")
    }

    return result.replace(/\n([ \t]*\n)+/g, "\n\n").trim()
}
