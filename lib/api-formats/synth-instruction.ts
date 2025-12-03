export interface ToolTracker {
    seenToolResultIds: Set<string>
    toolResultCount: number  // Tools since last prune
    skipNextIdle: boolean
    getToolName?: (callId: string) => string | undefined
}

export function createToolTracker(): ToolTracker {
    return { seenToolResultIds: new Set(), toolResultCount: 0, skipNextIdle: false }
}

/** Reset tool count to 0 (called after a prune event) */
export function resetToolTrackerCount(tracker: ToolTracker): void {
    tracker.toolResultCount = 0
}

/**
 * Counts total tool results in OpenAI/Anthropic messages (without tracker).
 * Used for determining if nudge threshold is met.
 */
export function countToolResults(messages: any[]): number {
    let count = 0
    for (const m of messages) {
        if (m.role === 'tool') {
            count++
        } else if (m.role === 'user' && Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'tool_result') {
                    count++
                }
            }
        }
    }
    return count
}

/**
 * Counts total tool results in Gemini contents (without tracker).
 */
export function countToolResultsGemini(contents: any[]): number {
    let count = 0
    for (const content of contents) {
        if (!Array.isArray(content.parts)) continue
        for (const part of content.parts) {
            if (part.functionResponse) {
                count++
            }
        }
    }
    return count
}

/**
 * Counts total tool results in OpenAI Responses API input (without tracker).
 */
export function countToolResultsResponses(input: any[]): number {
    let count = 0
    for (const item of input) {
        if (item.type === 'function_call_output') {
            count++
        }
    }
    return count
}

// ============================================================================
// OpenAI Chat / Anthropic Format
// ============================================================================

/** Check if a message content matches nudge text (OpenAI/Anthropic format) */
function isNudgeMessage(msg: any, nudgeText: string): boolean {
    if (typeof msg.content === 'string') {
        return msg.content === nudgeText
    }
    return false
}

export function injectSynth(messages: any[], instruction: string, nudgeText: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.role === 'user') {
            // Skip nudge messages - find real user message
            if (isNudgeMessage(msg, nudgeText)) continue
            
            if (typeof msg.content === 'string') {
                if (msg.content.includes(instruction)) return false
                msg.content = msg.content + '\n\n' + instruction
            } else if (Array.isArray(msg.content)) {
                const alreadyInjected = msg.content.some(
                    (part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(instruction)
                )
                if (alreadyInjected) return false
                msg.content.push({ type: 'text', text: instruction })
            }
            return true
        }
    }
    return false
}

// ============================================================================
// Google/Gemini Format (body.contents with parts)
// ============================================================================

/** Check if a Gemini content matches nudge text */
function isNudgeContentGemini(content: any, nudgeText: string): boolean {
    if (Array.isArray(content.parts) && content.parts.length === 1) {
        const part = content.parts[0]
        return part?.text === nudgeText
    }
    return false
}

export function injectSynthGemini(contents: any[], instruction: string, nudgeText: string): boolean {
    for (let i = contents.length - 1; i >= 0; i--) {
        const content = contents[i]
        if (content.role === 'user' && Array.isArray(content.parts)) {
            // Skip nudge messages - find real user message
            if (isNudgeContentGemini(content, nudgeText)) continue
            
            const alreadyInjected = content.parts.some(
                (part: any) => part?.text && typeof part.text === 'string' && part.text.includes(instruction)
            )
            if (alreadyInjected) return false
            content.parts.push({ text: instruction })
            return true
        }
    }
    return false
}

// ============================================================================
// OpenAI Responses API Format (body.input with type-based items)
// ============================================================================

/** Check if a Responses API item matches nudge text */
function isNudgeItemResponses(item: any, nudgeText: string): boolean {
    if (typeof item.content === 'string') {
        return item.content === nudgeText
    }
    return false
}

export function injectSynthResponses(input: any[], instruction: string, nudgeText: string): boolean {
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i]
        if (item.type === 'message' && item.role === 'user') {
            // Skip nudge messages - find real user message
            if (isNudgeItemResponses(item, nudgeText)) continue
            
            if (typeof item.content === 'string') {
                if (item.content.includes(instruction)) return false
                item.content = item.content + '\n\n' + instruction
            } else if (Array.isArray(item.content)) {
                const alreadyInjected = item.content.some(
                    (part: any) => part?.type === 'input_text' && typeof part.text === 'string' && part.text.includes(instruction)
                )
                if (alreadyInjected) return false
                item.content.push({ type: 'input_text', text: instruction })
            }
            return true
        }
    }
    return false
}
