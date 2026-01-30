// Cache for compiled regex patterns
const patternCache = new Map<string, RegExp>()
const CACHE_MAX_SIZE = 100 // Prevent memory bloat

function normalizePath(input: string): string {
    // Use replaceAll for better performance or single regex
    return input.includes('\\') ? input.replaceAll('\\', '/') : input
}

function escapeRegExpChar(ch: string): string {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch
}

function buildGlobRegex(pattern: string): string {
    const parts: string[] = []
    
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i]
        
        if (ch === "*") {
            const next = pattern[i + 1]
            if (next === "*") {
                const after = pattern[i + 2]
                if (after === "/") {
                    parts.push("(?:.*/)?")
                    i += 2
                    continue
                }
                parts.push(".*")
                i++
                continue
            }
            parts.push("[^/]*")
            continue
        }
        
        if (ch === "?") {
            parts.push("[^/]")
            continue
        }
        
        if (ch === "/") {
            parts.push("/")
            continue
        }
        
        // Escape special regex characters
        if (/[\\.^$+{}()|\[\]]/.test(ch)) {
            parts.push(`\\${ch}`)
        } else {
            parts.push(ch)
        }
    }
    
    return "^" + parts.join("") + "$"
}

function getCompiledRegex(pattern: string): RegExp {
    // Check cache first
    const cached = patternCache.get(pattern)
    if (cached) {
        return cached
    }
    
    // Build regex string using optimized function
    const regex = buildGlobRegex(pattern)
    
    // Compile and cache
    const compiled = new RegExp(regex)
    
    // Manage cache size (LRU-like eviction)
    if (patternCache.size >= CACHE_MAX_SIZE) {
        // Remove oldest entry (first entry in Map)
        const firstKey = patternCache.keys().next().value
        if (firstKey !== undefined) {
            patternCache.delete(firstKey)
        }
    }
    
    patternCache.set(pattern, compiled)
    return compiled
}

/**
 * Basic glob matching with support for `**`, `*`, and `?`.
 *
 * Notes:
 * - Matching is performed against the full (normalized) string.
 * - `*` and `?` do not match `/`.
 * - `**` matches across `/`.
 * - Uses compiled regex cache for performance optimization.
 */
export function matchesGlob(inputPath: string, pattern: string): boolean {
    if (!pattern) return false

    const input = normalizePath(inputPath)
    const pat = normalizePath(pattern)

    const regex = getCompiledRegex(pat)
    return regex.test(input)
}

export function getFilePathFromParameters(parameters: unknown): string | undefined {
    if (typeof parameters !== "object" || parameters === null) {
        return undefined
    }

    const filePath = (parameters as Record<string, unknown>).filePath
    return typeof filePath === "string" && filePath.length > 0 ? filePath : undefined
}

export function isProtectedFilePath(filePath: string | undefined, patterns: string[]): boolean {
    if (!filePath) return false
    if (!patterns || patterns.length === 0) return false

    return patterns.some((pattern) => matchesGlob(filePath, pattern))
}
