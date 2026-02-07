import { partial_ratio } from "fuzzball"
import type { WithParts, CompressSummary } from "../state"
import type { Logger } from "../logger"

export interface FuzzyConfig {
    minScore: number
    minGap: number
}

export const DEFAULT_FUZZY_CONFIG: FuzzyConfig = {
    minScore: 95,
    minGap: 15,
}

interface MatchResult {
    messageId: string
    messageIndex: number
    score: number
    matchType: "exact" | "fuzzy"
}

function extractMessageContent(msg: WithParts): string {
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    let content = ""

    for (const part of parts) {
        const p = part as Record<string, unknown>

        switch (part.type) {
            case "text":
            case "reasoning":
                if (typeof p.text === "string") {
                    content += " " + p.text
                }
                break

            case "tool": {
                const state = p.state as Record<string, unknown> | undefined
                if (!state) break

                // Include tool output (completed or error)
                if (state.status === "completed" && typeof state.output === "string") {
                    content += " " + state.output
                } else if (state.status === "error" && typeof state.error === "string") {
                    content += " " + state.error
                }

                // Include tool input
                if (state.input) {
                    content +=
                        " " +
                        (typeof state.input === "string"
                            ? state.input
                            : JSON.stringify(state.input))
                }
                break
            }

            case "compaction":
                if (typeof p.summary === "string") {
                    content += " " + p.summary
                }
                break

            case "subtask":
                if (typeof p.summary === "string") {
                    content += " " + p.summary
                }
                if (typeof p.result === "string") {
                    content += " " + p.result
                }
                break
        }
    }

    return content
}

function findExactMatches(
    messages: WithParts[],
    searchString: string,
    compressSummaries: CompressSummary[],
): MatchResult[] {
    const matches: MatchResult[] = []
    const seenMessageIds = new Set<string>()

    // Search compress summaries first
    for (const summary of compressSummaries) {
        if (summary.summary.includes(searchString)) {
            const anchorIndex = messages.findIndex((m) => m.info.id === summary.anchorMessageId)
            if (anchorIndex !== -1 && !seenMessageIds.has(summary.anchorMessageId)) {
                seenMessageIds.add(summary.anchorMessageId)
                matches.push({
                    messageId: summary.anchorMessageId,
                    messageIndex: anchorIndex,
                    score: 100,
                    matchType: "exact",
                })
            }
        }
    }

    // Search raw messages
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (seenMessageIds.has(msg.info.id)) continue

        const content = extractMessageContent(msg)
        if (content.includes(searchString)) {
            seenMessageIds.add(msg.info.id)
            matches.push({
                messageId: msg.info.id,
                messageIndex: i,
                score: 100,
                matchType: "exact",
            })
        }
    }

    return matches
}

function findFuzzyMatches(
    messages: WithParts[],
    searchString: string,
    compressSummaries: CompressSummary[],
    minScore: number,
): MatchResult[] {
    const matches: MatchResult[] = []
    const seenMessageIds = new Set<string>()

    // Search compress summaries first
    for (const summary of compressSummaries) {
        const score = partial_ratio(searchString, summary.summary)
        if (score >= minScore) {
            const anchorIndex = messages.findIndex((m) => m.info.id === summary.anchorMessageId)
            if (anchorIndex !== -1 && !seenMessageIds.has(summary.anchorMessageId)) {
                seenMessageIds.add(summary.anchorMessageId)
                matches.push({
                    messageId: summary.anchorMessageId,
                    messageIndex: anchorIndex,
                    score,
                    matchType: "fuzzy",
                })
            }
        }
    }

    // Search raw messages
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (seenMessageIds.has(msg.info.id)) continue

        const content = extractMessageContent(msg)
        const score = partial_ratio(searchString, content)
        if (score >= minScore) {
            seenMessageIds.add(msg.info.id)
            matches.push({
                messageId: msg.info.id,
                messageIndex: i,
                score,
                matchType: "fuzzy",
            })
        }
    }

    return matches
}

export function findStringInMessages(
    messages: WithParts[],
    searchString: string,
    logger: Logger,
    compressSummaries: CompressSummary[] = [],
    stringType: "startString" | "endString",
    fuzzyConfig: FuzzyConfig = DEFAULT_FUZZY_CONFIG,
): { messageId: string; messageIndex: number } {
    const searchableMessages = messages.length > 1 ? messages.slice(0, -1) : messages
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined

    const exactMatches = findExactMatches(searchableMessages, searchString, compressSummaries)

    if (exactMatches.length === 1) {
        return { messageId: exactMatches[0].messageId, messageIndex: exactMatches[0].messageIndex }
    }

    if (exactMatches.length > 1) {
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Provide more surrounding context to uniquely identify the intended match.`,
        )
    }

    const fuzzyMatches = findFuzzyMatches(
        searchableMessages,
        searchString,
        compressSummaries,
        fuzzyConfig.minScore,
    )

    if (fuzzyMatches.length === 0) {
        if (lastMessage) {
            const lastMsgContent = extractMessageContent(lastMessage)
            const lastMsgIndex = messages.length - 1
            if (lastMsgContent.includes(searchString)) {
                // logger.info(
                //     `${stringType} found in last message (last resort) at index ${lastMsgIndex}`,
                // )
                return {
                    messageId: lastMessage.info.id,
                    messageIndex: lastMsgIndex,
                }
            }
        }

        throw new Error(
            `${stringType} not found in conversation. ` +
                `Make sure the string exists and is spelled exactly as it appears.`,
        )
    }

    fuzzyMatches.sort((a, b) => b.score - a.score)

    const best = fuzzyMatches[0]
    const secondBest = fuzzyMatches[1]

    // Log fuzzy match candidates
    // logger.info(
    //     `Fuzzy match for ${stringType}: best=${best.score}% (msg ${best.messageIndex})` +
    //     (secondBest
    //         ? `, secondBest=${secondBest.score}% (msg ${secondBest.messageIndex})`
    //         : ""),
    // )

    // Check confidence gap - best must be significantly better than second best
    if (secondBest && best.score - secondBest.score < fuzzyConfig.minGap) {
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Provide more unique surrounding context to disambiguate.`,
        )
    }

    logger.info(
        `Fuzzy matched ${stringType} with ${best.score}% confidence at message index ${best.messageIndex}`,
    )

    return { messageId: best.messageId, messageIndex: best.messageIndex }
}

export function collectToolIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const toolIds: string[] = []

    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []

        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                if (!toolIds.includes(part.callID)) {
                    toolIds.push(part.callID)
                }
            }
        }
    }

    return toolIds
}

export function collectMessageIdsInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const messageIds: string[] = []

    for (let i = startIndex; i <= endIndex; i++) {
        const msgId = messages[i].info.id
        if (!messageIds.includes(msgId)) {
            messageIds.push(msgId)
        }
    }

    return messageIds
}

export function collectContentInRange(
    messages: WithParts[],
    startIndex: number,
    endIndex: number,
): string[] {
    const contents: string[] = []
    for (let i = startIndex; i <= endIndex; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "text") {
                contents.push(part.text)
            } else if (part.type === "tool") {
                const toolState = part.state as any
                if (toolState?.input) {
                    contents.push(
                        typeof toolState.input === "string"
                            ? toolState.input
                            : JSON.stringify(toolState.input),
                    )
                }
                if (toolState?.status === "completed" && toolState?.output) {
                    contents.push(
                        typeof toolState.output === "string"
                            ? toolState.output
                            : JSON.stringify(toolState.output),
                    )
                } else if (toolState?.status === "error" && toolState?.error) {
                    contents.push(
                        typeof toolState.error === "string"
                            ? toolState.error
                            : JSON.stringify(toolState.error),
                    )
                }
            }
        }
    }
    return contents
}
