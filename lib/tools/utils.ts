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

interface AnchorQuery {
    type: "muid" | "uid"
    value: string
    id: string
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
    const total = matches.length
    const omitted = Math.max(0, total - sample.length)
    return { sample, total, omitted }
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

function parseAnchorQuery(searchString: string): AnchorQuery | undefined {
    const muid = searchString.match(/^\[(muid)_(\d+)\]$/)
    if (muid) {
        return {
            type: "muid",
            value: searchString,
            id: muid[2],
        }
    }

    const uid = searchString.match(/^\[(uid)_(\d+)\]$/)
    if (uid) {
        return {
            type: "uid",
            value: searchString,
            id: uid[2],
        }
    }

    return undefined
}

function findAnchorMatches(messages: WithParts[], anchor: AnchorQuery): MatchResult[] {
    if (anchor.type === "muid") {
        const matches: MatchResult[] = []
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]
            if (msg.info.role !== "user") {
                continue
            }
            const parts = Array.isArray(msg.parts) ? msg.parts : []
            const found = parts.some(
                (part) =>
                    part.type === "text" &&
                    typeof part.text === "string" &&
                    part.text.startsWith(anchor.value),
            )
            if (!found) {
                continue
            }
            matches.push({
                messageId: msg.info.id,
                messageIndex: i,
                score: 100,
                matchType: "exact",
            })
        }
        return matches
    }

    const matches: MatchResult[] = []
    const uidPrefix = new RegExp(`^\\[uid_${anchor.id}(?:\\]|,)`)
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const found = parts.some((part) => {
            if (part.type !== "tool") {
                return false
            }

            const output = part.state?.status === "completed" ? part.state.output : undefined
            if (typeof output === "string" && uidPrefix.test(output)) {
                return true
            }

            const error = part.state?.status === "error" ? part.state.error : undefined
            if (typeof error === "string" && uidPrefix.test(error)) {
                return true
            }

            return false
        })
        if (!found) {
            continue
        }
        matches.push({
            messageId: msg.info.id,
            messageIndex: i,
            score: 100,
            matchType: "exact",
        })
    }
    return matches
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
    stringType: "startString" | "endString",
    fuzzyConfig: FuzzyConfig = DEFAULT_FUZZY_CONFIG,
): { messageId: string; messageIndex: number } {
    clog.info(C.BOUNDARY, `findStringInMessages called for ${stringType}`, {
        searchStringPreview: searchString.substring(0, 150),
        searchStringLen: searchString.length,
        totalMessages: messages.length,
        fuzzyConfig,
    })

    const searchableMessages = messages.length > 1 ? messages.slice(0, -1) : messages
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
    const anchor = parseAnchorQuery(searchString)

    if (anchor) {
        const anchorMatches = findAnchorMatches(searchableMessages, anchor)
        const anchorSummary = summarizeMatches(anchorMatches)
        clog.info(C.BOUNDARY, `${stringType}: anchor match results`, {
            type: anchor.type,
            count: anchorSummary.total,
            sample: anchorSummary.sample,
            omitted: anchorSummary.omitted,
        })

        if (anchorMatches.length === 1) {
            clog.info(C.BOUNDARY, `${stringType}: single anchor match found`, {
                messageId: anchorMatches[0].messageId,
                messageIndex: anchorMatches[0].messageIndex,
            })
            return {
                messageId: anchorMatches[0].messageId,
                messageIndex: anchorMatches[0].messageIndex,
            }
        }

        if (anchorMatches.length > 1) {
            clog.error(C.BOUNDARY, `${stringType}: MULTIPLE anchor matches - ambiguous`, {
                type: anchor.type,
                count: anchorMatches.length,
                matches: anchorMatches.map((m) => ({ msgId: m.messageId, idx: m.messageIndex })),
                searchString: searchString.substring(0, 150),
            })
            throw new Error(
                `Found multiple matches for ${stringType}. ` +
                    `Use a different [muid_x] or [uid_x] anchor that appears only once.`,
            )
        }

        clog.error(C.BOUNDARY, `${stringType}: anchor NOT FOUND`, {
            type: anchor.type,
            searchString: searchString.substring(0, 150),
            messageCount: searchableMessages.length,
        })
        throw new Error(
            `${stringType} anchor not found in conversation. ` +
                `Use an existing [muid_x] or [uid_x] marker from the current context.`,
        )
    }

    clog.debug(
        C.BOUNDARY,
        `${stringType}: searching ${searchableMessages.length} messages (last message excluded=${messages.length > 1})`,
    )

    const exactMatches = findExactMatches(searchableMessages, searchString)
    const exactSummary = summarizeMatches(exactMatches)

    clog.info(C.BOUNDARY, `${stringType}: exact match results`, {
        count: exactSummary.total,
        sample: exactSummary.sample,
        omitted: exactSummary.omitted,
    })

    if (exactMatches.length === 1) {
        clog.info(C.BOUNDARY, `${stringType}: single exact match found`, {
            messageId: exactMatches[0].messageId,
            messageIndex: exactMatches[0].messageIndex,
        })
        return { messageId: exactMatches[0].messageId, messageIndex: exactMatches[0].messageIndex }
    }

    if (exactMatches.length > 1) {
        clog.error(C.BOUNDARY, `${stringType}: MULTIPLE exact matches - ambiguous`, {
            count: exactMatches.length,
            matches: exactMatches.map((m) => ({ msgId: m.messageId, idx: m.messageIndex })),
            searchString: searchString.substring(0, 150),
        })
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Use a [muid_x] or [uid_x] anchor when possible, or provide more unique surrounding context.`,
        )
    }

    clog.info(
        C.BOUNDARY,
        `${stringType}: no exact match, trying fuzzy (minScore=${fuzzyConfig.minScore}, minGap=${fuzzyConfig.minGap})`,
    )

    const fuzzyMatches = findFuzzyMatches(searchableMessages, searchString, fuzzyConfig.minScore)
    const fuzzySummary = summarizeMatches(fuzzyMatches)

    clog.info(C.BOUNDARY, `${stringType}: fuzzy match results`, {
        count: fuzzySummary.total,
        sample: fuzzySummary.sample,
        omitted: fuzzySummary.omitted,
    })

    if (fuzzyMatches.length === 0) {
        clog.warn(C.BOUNDARY, `${stringType}: no fuzzy matches, trying last message as last resort`)

        if (lastMessage && !isIgnoredUserMessage(lastMessage)) {
            const lastMsgContent = extractMessageContent(lastMessage)
            const lastMsgIndex = messages.length - 1
            clog.debug(
                C.BOUNDARY,
                `${stringType}: last message content length=${lastMsgContent.length}, id=${lastMessage.info.id}`,
            )
            if (lastMsgContent.includes(searchString)) {
                clog.info(C.BOUNDARY, `${stringType}: found in last message (last resort)`, {
                    messageId: lastMessage.info.id,
                    messageIndex: lastMsgIndex,
                })
                return {
                    messageId: lastMessage.info.id,
                    messageIndex: lastMsgIndex,
                }
            }
            clog.warn(C.BOUNDARY, `${stringType}: NOT found in last message either`)
        }

        clog.error(C.BOUNDARY, `${stringType}: NOT FOUND ANYWHERE`, {
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

    clog.info(C.BOUNDARY, `${stringType}: fuzzy ranking`, {
        best: { msgId: best.messageId, idx: best.messageIndex, score: best.score },
        secondBest: secondBest
            ? { msgId: secondBest.messageId, idx: secondBest.messageIndex, score: secondBest.score }
            : null,
        gap: secondBest ? best.score - secondBest.score : "N/A",
        requiredGap: fuzzyConfig.minGap,
    })

    // Check confidence gap - best must be significantly better than second best
    if (secondBest && best.score - secondBest.score < fuzzyConfig.minGap) {
        clog.error(C.BOUNDARY, `${stringType}: AMBIGUOUS fuzzy match - gap too small`, {
            bestScore: best.score,
            secondBestScore: secondBest.score,
            gap: best.score - secondBest.score,
            requiredGap: fuzzyConfig.minGap,
        })
        throw new Error(
            `Found multiple matches for ${stringType}. ` +
                `Use a [muid_x] or [uid_x] anchor when possible, or provide more unique surrounding context to disambiguate.`,
        )
    }

    clog.info(C.BOUNDARY, `${stringType}: fuzzy match accepted`, {
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
