/**
 * Normalizes model-emitted `content` arguments for the compress tools.
 *
 * Some models emit `content` as a single entry object or a JSON-encoded string
 * instead of the required array of entry objects. When the intent is
 * unambiguous we coerce it into the array form; when the payload is a plain
 * string (a summary with no range boundaries) we throw a guiding error that
 * tells the model exactly how to re-send the call.
 */

export function coerceContentArray<T>(
    raw: unknown,
    isEntry: (value: unknown) => value is T,
    guidance: string,
): T[] {
    if (Array.isArray(raw)) {
        return raw as T[]
    }

    if (typeof raw === "string") {
        const trimmed = raw.trim()
        if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
            let parsed: unknown
            try {
                parsed = JSON.parse(trimmed)
            } catch {
                parsed = undefined
            }
            if (Array.isArray(parsed)) {
                if (parsed.length === 0) {
                    throw new Error("content is required and must be a non-empty array")
                }
                return parsed as T[]
            }
            if (isEntry(parsed)) {
                return [parsed]
            }
        }
        throw new Error(`content must be a JSON array, not a plain string. ${guidance}`)
    }

    if (raw !== null && typeof raw === "object" && isEntry(raw)) {
        return [raw as T]
    }

    throw new Error("content is required and must be a non-empty array")
}
