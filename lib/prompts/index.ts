import { readFileSync } from "fs"
import { join } from "path"

export function loadPrompt(name: string, vars?: Record<string, string>): string {
    const filePath = join(__dirname, `${name}.txt`)
    let content = readFileSync(filePath, "utf8").trim()
    if (vars) {
        for (const [key, value] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
        }
    }
    return content
}
