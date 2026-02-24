import { SYSTEM as SYSTEM_PROMPT } from "./_codegen/system.generated"

export function renderSystemPrompt(manual?: boolean): string {
    let result = SYSTEM_PROMPT
    result = result.replace(/\/\/.*?\/\//g, "")

    if (!manual) {
        const regex = new RegExp(`<manual>[\\s\\S]*?</manual>`, "g")
        result = result.replace(regex, "")
    }

    return result.replace(/\n([ \t]*\n)+/g, "\n\n").trim()
}
