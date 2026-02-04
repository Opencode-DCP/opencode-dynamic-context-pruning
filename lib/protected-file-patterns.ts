function normalizePath(input: string): string {
    return input.replaceAll("\\\\", "/")
}

function escapeRegExpChar(ch: string): string {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch
}

/**
 * Basic glob matching with support for `**`, `*`, and `?`.
 *
 * Notes:
 * - Matching is performed against the full (normalized) string.
 * - `*` and `?` do not match `/`.
 * - `**` matches across `/`.
 */
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
    if (tool === "apply_patch" && typeof params.patchText === "string") {
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

    // Return unique non-empty paths
    return [...new Set(paths)].filter((p) => p.length > 0)
}

export function isProtected(filePaths: string[], patterns: string[]): boolean {
    if (!filePaths || filePaths.length === 0) return false
    if (!patterns || patterns.length === 0) return false

    return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)))
}
