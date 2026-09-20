function normalizePath(input: string): string {
    // A single backslash. In source, "\\" is the one-character string; the
    // previous "\\\\" was a *two*-character string, so it only ever matched a
    // doubled separator -- which a real Windows path does not contain. The
    // normalisation was therefore a no-op on the only platform that needs it.
    return input.replaceAll("\\", "/")
}

function escapeRegExpChar(ch: string): string {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch
}

export function matchesGlob(inputPath: string, pattern: string): boolean {
    if (!pattern) return false

    const input = normalizePath(inputPath)
    const pat = normalizePath(pattern)

    let regex = "^"

    for (let i = 0; i < pat.length; i++) {
        const ch = pat[i]

        if (ch === "*") {
            const next = pat[i + 1]
            if (next === "*") {
                const after = pat[i + 2]
                if (after === "/") {
                    // **/  (zero or more directories)
                    regex += "(?:.*/)?"
                    i += 2
                    continue
                }

                // **
                regex += ".*"
                i++
                continue
            }

            // *
            regex += "[^/]*"
            continue
        }

        if (ch === "?") {
            regex += "[^/]"
            continue
        }

        if (ch === "/") {
            regex += "/"
            continue
        }

        regex += escapeRegExpChar(ch)
    }

    regex += "$"

    return new RegExp(regex).test(input)
}

export function getFilePathsFromParameters(tool: string, parameters: unknown): string[] {
    if (typeof parameters !== "object" || parameters === null) {
        return []
    }

    const paths: string[] = []
    const params = parameters as Record<string, any>

    // 1. apply_patch uses patchText with embedded paths
    if ((tool === "apply_patch" || tool === "patch") && typeof params.patchText === "string") {
        const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g
        let match
        while ((match = pathRegex.exec(params.patchText)) !== null) {
            paths.push(match[1].trim())
        }
    }

    // 2. multiedit uses top-level filePath and nested edits array
    if (tool === "multiedit") {
        if (typeof params.filePath === "string") {
            paths.push(params.filePath)
        }
        if (Array.isArray(params.edits)) {
            for (const edit of params.edits) {
                if (edit && typeof edit.filePath === "string") {
                    paths.push(edit.filePath)
                }
            }
        }
    }

    // 3. Default check for common filePath parameter (read, write, edit, etc)
    if (typeof params.filePath === "string") {
        paths.push(params.filePath)
    }

    // V2 file tools use path rather than filePath.
    if (["read", "write", "edit"].includes(tool) && typeof params.path === "string") {
        paths.push(params.path)
    }

    // Return unique non-empty paths
    return [...new Set(paths)].filter((p) => p.length > 0)
}

export function isFilePathProtected(filePaths: string[], patterns: string[]): boolean {
    if (!filePaths || filePaths.length === 0) return false
    if (!patterns || patterns.length === 0) return false

    return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)))
}

const GLOB_CHARS = /[*?]/

export function isToolNameProtected(toolName: string, patterns: string[]): boolean {
    if (!toolName || !patterns || patterns.length === 0) return false

    const exactPatterns: Set<string> = new Set()
    const globPatterns: string[] = []

    for (const pattern of patterns) {
        if (GLOB_CHARS.test(pattern)) {
            globPatterns.push(pattern)
        } else {
            exactPatterns.add(pattern)
        }
    }

    if (exactPatterns.has(toolName)) {
        return true
    }

    return globPatterns.some((pattern) => matchesGlob(toolName, pattern))
}

export function isToolProtected(
    tool: string,
    input: unknown,
    tools: string[],
    files: string[],
    metadata?: Record<string, unknown>,
): boolean {
    const calls = [{ tool, input }]
    // V2 Code Mode keeps nested inputs, but only one combined output. Protect
    // that output as a whole when any nested call matches the user's rules.
    if (tool === "execute" && Array.isArray(metadata?.toolCalls)) {
        for (const call of metadata.toolCalls) {
            if (call && typeof call.tool === "string") calls.push(call)
        }
    }
    return calls.some(
        (call) =>
            isToolNameProtected(call.tool, tools) ||
            isFilePathProtected(getFilePathsFromParameters(call.tool, call.input), files),
    )
}
