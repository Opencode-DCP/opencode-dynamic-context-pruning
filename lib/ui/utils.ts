import { SessionState, ToolParameterEntry, WithParts } from "../state"
import { countTokens, extractToolContent } from "../strategies/utils"
import { clog, C } from "../compress-logger"
import { isIgnoredUserMessage } from "../messages/utils"

function extractParameterKey(tool: string, parameters: any): string {
    if (!parameters) return ""

    if (tool === "read" && parameters.filePath) {
        const offset = parameters.offset
        const limit = parameters.limit
        if (offset !== undefined && limit !== undefined) {
            return `${parameters.filePath} (lines ${offset}-${offset + limit})`
        }
        if (offset !== undefined) {
            return `${parameters.filePath} (lines ${offset}+)`
        }
        if (limit !== undefined) {
            return `${parameters.filePath} (lines 0-${limit})`
        }
        return parameters.filePath
    }

    if ((tool === "write" || tool === "edit" || tool === "multiedit") && parameters.filePath) {
        return parameters.filePath
    }

    if (tool === "apply_patch" && typeof parameters.patchText === "string") {
        const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g
        const paths: string[] = []
        let match
        while ((match = pathRegex.exec(parameters.patchText)) !== null) {
            paths.push(match[1].trim())
        }
        if (paths.length > 0) {
            const uniquePaths = [...new Set(paths)]
            const count = uniquePaths.length
            const plural = count > 1 ? "s" : ""
            if (count === 1) return uniquePaths[0]
            if (count === 2) return uniquePaths.join(", ")
            return `${count} file${plural}: ${uniquePaths[0]}, ${uniquePaths[1]}...`
        }
        return "patch"
    }

    if (tool === "list") {
        return parameters.path || "(current directory)"
    }

    if (tool === "glob") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return "(unknown pattern)"
    }

    if (tool === "grep") {
        if (parameters.pattern) {
            const pathInfo = parameters.path ? ` in ${parameters.path}` : ""
            return `"${parameters.pattern}"${pathInfo}`
        }
        return "(unknown pattern)"
    }

    if (tool === "bash") {
        if (parameters.description) return parameters.description
        if (parameters.command) {
            return parameters.command.length > 50
                ? parameters.command.substring(0, 50) + "..."
                : parameters.command
        }
    }

    if (tool === "webfetch" && parameters.url) {
        return parameters.url
    }
    if (tool === "websearch" && parameters.query) {
        return `"${parameters.query}"`
    }
    if (tool === "codesearch" && parameters.query) {
        return `"${parameters.query}"`
    }

    if (tool === "todowrite") {
        return `${parameters.todos?.length || 0} todos`
    }
    if (tool === "todoread") {
        return "read todo list"
    }

    if (tool === "task" && parameters.description) {
        return parameters.description
    }
    if (tool === "skill" && parameters.name) {
        return parameters.name
    }

    if (tool === "lsp") {
        const op = parameters.operation || "lsp"
        const path = parameters.filePath || ""
        const line = parameters.line
        const char = parameters.character
        if (path && line !== undefined && char !== undefined) {
            return `${op} ${path}:${line}:${char}`
        }
        if (path) {
            return `${op} ${path}`
        }
        return op
    }

    if (tool === "question") {
        const questions = parameters.questions
        if (Array.isArray(questions) && questions.length > 0) {
            const headers = questions
                .map((q: any) => q.header || "")
                .filter(Boolean)
                .slice(0, 3)

            const count = questions.length
            const plural = count > 1 ? "s" : ""

            if (headers.length > 0) {
                const suffix = count > 3 ? ` (+${count - 3} more)` : ""
                return `${count} question${plural}: ${headers.join(", ")}${suffix}`
            }
            return `${count} question${plural}`
        }
        return "question"
    }

    const paramStr = JSON.stringify(parameters)
    if (paramStr === "{}" || paramStr === "[]" || paramStr === "null") {
        return ""
    }

    return paramStr.substring(0, 50)
}

export function countDistillationTokens(distillation?: string[]): number {
    if (!distillation || distillation.length === 0) return 0
    return countTokens(distillation.join("\n"))
}

export function formatExtracted(distillation?: string[]): string {
    if (!distillation || distillation.length === 0) {
        return ""
    }
    let result = `\n\n▣ Extracted`
    for (const finding of distillation) {
        result += `\n───\n${finding}`
    }
    return result
}

export function formatStatsHeader(totalTokensSaved: number, pruneTokenCounter: number): string {
    const totalTokensSavedStr = `~${formatTokenCount(totalTokensSaved + pruneTokenCounter)}`
    return [`▣ DCP | ${totalTokensSavedStr} saved total`].join("\n")
}

export function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`.replace(".0K", "K") + " tokens"
    }
    return tokens.toString() + " tokens"
}

export function truncate(str: string, maxLen: number = 60): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + "..."
}

export interface CompressionGraphData {
    systemTokens: number
    recentCompressedTokens: number
    olderCompressedTokens: number
    remainingTokens: number
    totalSessionTokens: number
}

function countMessageTokensExcludingPrunedTools(state: SessionState, msg: WithParts): number {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const texts: string[] = []

    for (const part of parts) {
        if ((part as any).ignored) {
            continue
        }

        if (part.type === "text") {
            texts.push(part.text)
            continue
        }

        if (part.type !== "tool") {
            continue
        }

        if (!part.callID || state.prune.tools.has(part.callID)) {
            continue
        }

        texts.push(...extractToolContent(part))
    }

    if (texts.length === 0) {
        return 0
    }
    return countTokens(texts.join(" "))
}

function buildToolParentMap(messages: WithParts[]): Map<string, string> {
    const map = new Map<string, string>()

    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type !== "tool" || !part.callID) {
                continue
            }
            map.set(part.callID, msg.info.id)
        }
    }

    return map
}

export function cacheSystemPromptTokens(state: SessionState, messages: WithParts[]): void {
    let firstInputTokens = 0
    for (const msg of messages) {
        if (msg.info.role !== "assistant") {
            continue
        }
        const info = msg.info as any
        const input = info?.tokens?.input || 0
        const cacheRead = info?.tokens?.cache?.read || 0
        if (input > 0 || cacheRead > 0) {
            firstInputTokens = input + cacheRead
            break
        }
    }

    if (firstInputTokens <= 0) {
        state.systemPromptTokens = undefined
        return
    }

    let firstUserText = ""
    for (const msg of messages) {
        if (msg.info.role !== "user" || isIgnoredUserMessage(msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text" && !(part as any).ignored) {
                firstUserText += part.text
            }
        }
        break
    }

    const estimatedSystemTokens = Math.max(0, firstInputTokens - countTokens(firstUserText))
    state.systemPromptTokens = estimatedSystemTokens > 0 ? estimatedSystemTokens : undefined
}

export function buildCompressionGraphData(
    state: SessionState,
    messages: WithParts[],
    newMessageIds: Set<string>,
    newToolIds: Set<string>,
): CompressionGraphData {
    const toolParentMap = buildToolParentMap(messages)
    const prunedMessageIds = new Set(state.prune.messages.keys())

    let compressedMessageTokens = 0
    for (const tokens of state.prune.messages.values()) {
        compressedMessageTokens += tokens
    }

    let compressedStandaloneToolTokens = 0
    for (const [toolId, toolTokens] of state.prune.tools.entries()) {
        const parentMessageId = toolParentMap.get(toolId)
        if (parentMessageId && prunedMessageIds.has(parentMessageId)) {
            continue
        }
        compressedStandaloneToolTokens += toolTokens
    }

    const compressedTotalTokens = compressedMessageTokens + compressedStandaloneToolTokens

    let recentMessageTokens = 0
    for (const messageId of newMessageIds) {
        recentMessageTokens += state.prune.messages.get(messageId) || 0
    }

    let recentStandaloneToolTokens = 0
    for (const toolId of newToolIds) {
        const parentMessageId = toolParentMap.get(toolId)

        if (parentMessageId && newMessageIds.has(parentMessageId)) {
            continue
        }

        if (parentMessageId && prunedMessageIds.has(parentMessageId)) {
            continue
        }

        recentStandaloneToolTokens += state.prune.tools.get(toolId) || 0
    }

    const recentCompressedTokens = recentMessageTokens + recentStandaloneToolTokens
    const olderCompressedTokens = Math.max(0, compressedTotalTokens - recentCompressedTokens)

    const messageIds = new Set(messages.map((m) => m.info.id))
    let remainingTokens = 0

    for (const msg of messages) {
        if (prunedMessageIds.has(msg.info.id)) {
            continue
        }
        if (msg.info.role === "user" && isIgnoredUserMessage(msg)) {
            continue
        }
        remainingTokens += countMessageTokensExcludingPrunedTools(state, msg)
    }

    for (const summary of state.compressSummaries) {
        if (!messageIds.has(summary.anchorMessageId)) {
            continue
        }
        remainingTokens += countTokens(summary.summary)
    }

    const systemTokens = state.systemPromptTokens ?? 0
    const totalSessionTokens =
        systemTokens + recentCompressedTokens + olderCompressedTokens + remainingTokens

    clog.info(C.COMPRESS, "Compression graph token accounting", {
        systemTokens,
        recentCompressedTokens,
        olderCompressedTokens,
        remainingTokens,
        totalSessionTokens,
    })

    return {
        systemTokens,
        recentCompressedTokens,
        olderCompressedTokens,
        remainingTokens,
        totalSessionTokens,
    }
}

function allocateSegmentWidths(values: number[], total: number, width: number): number[] {
    if (total <= 0 || width <= 0) {
        return new Array(values.length).fill(0)
    }

    const raw = values.map((v) => (v / total) * width)
    const base = raw.map((v) => Math.floor(v))
    let used = base.reduce((acc, v) => acc + v, 0)

    const order = raw
        .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
        .sort((a, b) => b.frac - a.frac)

    for (let i = 0; used < width && i < order.length; i++) {
        base[order[i].idx] += 1
        used++
    }

    return base
}

export function formatCompressionGraph(data: CompressionGraphData, width: number = 50): string {
    const values = [
        data.systemTokens,
        data.recentCompressedTokens,
        data.olderCompressedTokens,
        data.remainingTokens,
    ]
    const chars = ["▌", "⣿", "░", "█"]
    const segmentWidths = allocateSegmentWidths(values, data.totalSessionTokens, width)

    let bar = ""
    for (let i = 0; i < segmentWidths.length; i++) {
        bar += chars[i].repeat(Math.max(0, segmentWidths[i]))
    }

    if (bar.length < width) {
        bar += " ".repeat(width - bar.length)
    }

    return `│${bar}│`
}

export function formatCompressionGraphLegend(): string {
    return "→ Legend: ▌ system | ⣿ recent compress | ░ older compressed | █ in context"
}

export function shortenPath(input: string, workingDirectory?: string): string {
    const inPathMatch = input.match(/^(.+) in (.+)$/)
    if (inPathMatch) {
        const prefix = inPathMatch[1]
        const pathPart = inPathMatch[2]
        const shortenedPath = shortenSinglePath(pathPart, workingDirectory)
        return `${prefix} in ${shortenedPath}`
    }

    return shortenSinglePath(input, workingDirectory)
}

function shortenSinglePath(path: string, workingDirectory?: string): string {
    if (workingDirectory) {
        if (path.startsWith(workingDirectory + "/")) {
            return path.slice(workingDirectory.length + 1)
        }
        if (path === workingDirectory) {
            return "."
        }
    }

    return path
}

export function formatPrunedItemsList(
    pruneToolIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string[] {
    const lines: string[] = []

    for (const id of pruneToolIds) {
        const metadata = toolMetadata.get(id)

        if (metadata) {
            const paramKey = extractParameterKey(metadata.tool, metadata.parameters)
            if (paramKey) {
                // Use 60 char limit to match notification style
                const displayKey = truncate(shortenPath(paramKey, workingDirectory), 60)
                lines.push(`→ ${metadata.tool}: ${displayKey}`)
            } else {
                lines.push(`→ ${metadata.tool}`)
            }
        }
    }

    const knownCount = pruneToolIds.filter((id) => toolMetadata.has(id)).length
    const unknownCount = pruneToolIds.length - knownCount

    if (unknownCount > 0) {
        lines.push(`→ (${unknownCount} tool${unknownCount > 1 ? "s" : ""} with unknown metadata)`)
    }

    return lines
}

export function formatPruningResultForTool(
    prunedIds: string[],
    toolMetadata: Map<string, ToolParameterEntry>,
    workingDirectory?: string,
): string {
    const lines: string[] = []
    lines.push(`Context pruning complete. Pruned ${prunedIds.length} tool outputs.`)
    lines.push("")

    if (prunedIds.length > 0) {
        lines.push(`Semantically pruned (${prunedIds.length}):`)
        lines.push(...formatPrunedItemsList(prunedIds, toolMetadata, workingDirectory))
    }

    return lines.join("\n").trim()
}
