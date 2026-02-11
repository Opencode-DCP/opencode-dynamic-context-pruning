import { partial_ratio } from "fuzzball"
import type { WithParts } from "../state"
import type { Logger } from "../logger"
import { isIgnoredUserMessage } from "../messages/utils"
import { clog, C } from "../compress-logger"

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

function summarizeMatches(
    matches: MatchResult[],
    limit = 8,
): {
    sample: Array<{ msgId: string; idx: number; score: number }>
    total: number
    omitted: number
} {
    const sample = matches.slice(0, limit).map((m) => ({
        msgId: m.messageId,
        idx: m.messageIndex,
        score: m.score,
    }))
    return { sample, total: matches.length, omitted: Math.max(0, matches.length - sample.length) }
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
    clog.info(C.BOUNDARY, `Search Configuration`, {
        type: stringType,
        targetText: searchString.substring(0, 150),
        targetLength: searchString.length,
        messages: messages.length,
        fuzzyMinScore: fuzzyConfig.minScore,
        fuzzyMinGap: fuzzyConfig.minGap,
    })

    const searchableMessages = messages.length > 1 ? messages.slice(0, -1) : messages
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined

    clog.debug(
        C.BOUNDARY,
        `Searching ${searchableMessages.length} messages\n(last message excluded: ${messages.length > 1})`,
    )

    const exactMatches = findExactMatches(searchableMessages, searchString)
    const exactSummary = summarizeMatches(exactMatches)

    clog.info(C.BOUNDARY, `Exact Match Results`, {
        count: exactSummary.total,
        matches: exactSummary.sample,
        omitted: exactSummary.omitted,
    })

    if (exactMatches.length === 1) {
        clog.info(C.BOUNDARY, `✓ Single exact match`, {
            messageId: exactMatches[0].messageId,
            messageIndex: exactMatches[0].messageIndex,
        })
        return { messageId: exactMatches[0].messageId, messageIndex: exactMatches[0].messageIndex }
    }

    if (exactMatches.length > 1) {
        clog.error(C.BOUNDARY, `✗ Multiple Exact Matches (ambiguous)`, {
            count: exactMatches.length,
            matches: exactMatches.map((m) => ({ msgId: m.messageId, idx: m.messageIndex })),
            searchPreview: searchString.substring(0, 150),
        })
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Provide more surrounding context to uniquely identify the intended match.`,
        )
    }

    clog.info(C.BOUNDARY, `No exact match\nAttempting fuzzy search...`, {
        minScore: fuzzyConfig.minScore,
        minGap: fuzzyConfig.minGap,
    })

    const fuzzyMatches = findFuzzyMatches(searchableMessages, searchString, fuzzyConfig.minScore)
    const fuzzySummary = summarizeMatches(fuzzyMatches)

    clog.info(C.BOUNDARY, `Fuzzy Match Results`, {
        count: fuzzySummary.total,
        matches: fuzzySummary.sample,
        omitted: fuzzySummary.omitted,
    })

    if (fuzzyMatches.length === 0) {
        clog.warn(C.BOUNDARY, `⚠ No fuzzy matches\nTrying last message as last resort...`)

        if (lastMessage && !isIgnoredUserMessage(lastMessage)) {
            const lastMsgContent = extractMessageContent(lastMessage)
            const lastMsgIndex = messages.length - 1
            clog.debug(C.BOUNDARY, `Last message check`, {
                messageId: lastMessage.info.id,
                contentLength: lastMsgContent.length,
            })
            if (lastMsgContent.includes(searchString)) {
                clog.info(C.BOUNDARY, `✓ Found in last message (last resort)`, {
                    messageId: lastMessage.info.id,
                    messageIndex: lastMsgIndex,
                })
                return {
                    messageId: lastMessage.info.id,
                    messageIndex: lastMsgIndex,
                }
            }
            clog.warn(C.BOUNDARY, `✗ Not found in last message either`)
        }

        clog.error(C.BOUNDARY, `✗ NOT FOUND ANYWHERE`, {
            searchString: searchString.substring(0, 200),
            searchStringLen: searchString.length,
            messageCount: messages.length,
            messageRoles: messages.map((m, i) => `${i}:${m.info.role}`),
        })
        throw new Error(
            `${stringType} not found in conversation. ` +
                `Make sure the string exists and is spelled exactly as it appears.`,
        )
    }

    fuzzyMatches.sort((a, b) => b.score - a.score)

    const best = fuzzyMatches[0]
    const secondBest = fuzzyMatches[1]

    clog.info(C.BOUNDARY, `Fuzzy Ranking`, {
        best: { msgId: best.messageId, idx: best.messageIndex, score: best.score },
        secondBest: secondBest
            ? { msgId: secondBest.messageId, idx: secondBest.messageIndex, score: secondBest.score }
            : null,
        gap: secondBest ? best.score - secondBest.score : "N/A",
        requiredGap: fuzzyConfig.minGap,
    })

    // Check confidence gap - best must be significantly better than second best
    if (secondBest && best.score - secondBest.score < fuzzyConfig.minGap) {
        clog.error(C.BOUNDARY, `✗ Ambiguous Fuzzy Match (gap too small)`, {
            best: best.score,
            secondBest: secondBest.score,
            gap: best.score - secondBest.score,
            required: fuzzyConfig.minGap,
        })
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Provide more unique surrounding context to disambiguate.`,
        )
    }

    clog.info(C.BOUNDARY, `✓ Fuzzy match accepted`, {
        messageId: best.messageId,
        messageIndex: best.messageIndex,
        score: best.score,
    })

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
