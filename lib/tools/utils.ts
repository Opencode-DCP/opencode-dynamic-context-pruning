import { partial_ratio } from "fuzzball"
import type { WithParts } from "../state"
import type { Logger } from "../logger"
import { isIgnoredUserMessage } from "../messages/utils"

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
        if ((part as any).ignored) {
            continue
        }

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

function findExactMatches(messages: WithParts[], searchString: string): MatchResult[] {
    const matches: MatchResult[] = []

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (isIgnoredUserMessage(msg)) {
            continue
        }
        const content = extractMessageContent(msg)
        if (content.includes(searchString)) {
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
    minScore: number,
): MatchResult[] {
    const matches: MatchResult[] = []

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (isIgnoredUserMessage(msg)) {
            continue
        }
        const content = extractMessageContent(msg)
        const score = partial_ratio(searchString, content)
        if (score >= minScore) {
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
    stringType: "startString" | "endString",
    fuzzyConfig: FuzzyConfig = DEFAULT_FUZZY_CONFIG,
): { messageId: string; messageIndex: number } {
    const searchableMessages = messages.length > 1 ? messages.slice(0, -1) : messages
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined

    const exactMatches = findExactMatches(searchableMessages, searchString)

    if (exactMatches.length === 1) {
        return { messageId: exactMatches[0].messageId, messageIndex: exactMatches[0].messageIndex }
    }

    if (exactMatches.length > 1) {
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Provide more surrounding context to uniquely identify the intended match.`,
        )
    }

    const fuzzyMatches = findFuzzyMatches(searchableMessages, searchString, fuzzyConfig.minScore)

    if (fuzzyMatches.length === 0) {
        if (lastMessage && !isIgnoredUserMessage(lastMessage)) {
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
