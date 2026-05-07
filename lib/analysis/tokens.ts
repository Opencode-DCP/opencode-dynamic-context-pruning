/**
 * Shared Token Analysis
 * Computes a breakdown of token usage across categories for a session.
 *
 * TOKEN CALCULATION STRATEGY
 * ==========================
 * We minimize tokenizer estimation by leveraging API-reported values wherever possible.
 *
 * WHAT WE GET FROM THE API (exact):
 *   - tokens.input    : Input tokens for each assistant response
 *   - tokens.output   : Output tokens generated (includes text + tool calls)
 *   - tokens.reasoning: Reasoning tokens used
 *   - tokens.cache    : Cache read/write tokens
 *
 * HOW WE CALCULATE EACH CATEGORY:
 *
 *   SYSTEM = firstAssistant.input + cache.read + cache.write - tokenizer(firstUserMessage)
 *            The first response's total input (input + cache.read + cache.write)
 *            contains system + first user message. On the first request of a
 *            session, the system prompt appears in cache.write (cache creation),
 *            not cache.read.
 *
 *   TOOLS  = tokenizer(toolInputs + toolOutputs) - prunedTokens
 *            We must tokenize tools anyway for pruning decisions.
 *
 *   USER   = tokenizer(all user messages)
 *            User messages are typically small, so estimation is acceptable.
 *
 *   ASSISTANT = total - system - user - tools
 *               Calculated as residual. This absorbs:
 *               - Assistant text output tokens
 *               - Reasoning tokens (if persisted by the model)
 *               - Any estimation errors
 *
 *   TOTAL  = input + output + reasoning + cache.read + cache.write
 *            Matches opencode's UI display.
 *
 * WHY ASSISTANT IS THE RESIDUAL:
 *   If reasoning tokens persist in context (model-dependent), they semantically
 *   belong with "Assistant" since reasoning IS assistant-generated content.
 */

import type { AssistantMessage, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import type { SessionState, WithParts } from "../state"
import { isIgnoredUserMessage } from "../messages/query"
import { isMessageCompacted } from "../state/utils"
import { countTokens, extractCompletedToolOutput } from "../token-utils"

export type MessageStatus = "active" | "pruned"

export interface TokenBreakdown {
    system: number
    user: number
    assistant: number
    tools: number
    toolCount: number
    toolsInContextCount: number
    prunedTokens: number
    prunedToolCount: number
    prunedMessageCount: number
    total: number
    messageCount: number
}

export interface TokenAnalysis {
    breakdown: TokenBreakdown
    messageStatuses: MessageStatus[]
}

export function emptyBreakdown(): TokenBreakdown {
    return {
        system: 0,
        user: 0,
        assistant: 0,
        tools: 0,
        toolCount: 0,
        toolsInContextCount: 0,
        prunedTokens: 0,
        prunedToolCount: 0,
        prunedMessageCount: 0,
        total: 0,
        messageCount: 0,
    }
}

export function analyzeTokens(state: SessionState, messages: WithParts[]): TokenAnalysis {
    const breakdown = emptyBreakdown()
    const messageStatuses: MessageStatus[] = []
    breakdown.prunedTokens = state.stats.totalPruneTokens

    let firstAssistant: AssistantMessage | undefined
    for (const msg of messages) {
        if (msg.info.role !== "assistant") continue
        const assistantInfo = msg.info as AssistantMessage
        if (
            assistantInfo.tokens?.input > 0 ||
            assistantInfo.tokens?.cache?.read > 0 ||
            assistantInfo.tokens?.cache?.write > 0
        ) {
            firstAssistant = assistantInfo
            break
        }
    }

    let lastAssistant: AssistantMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.info.role !== "assistant") continue
        const assistantInfo = msg.info as AssistantMessage
        if (assistantInfo.tokens?.output > 0) {
            lastAssistant = assistantInfo
            break
        }
    }

    const apiInput = lastAssistant?.tokens?.input || 0
    const apiOutput = lastAssistant?.tokens?.output || 0
    const apiReasoning = lastAssistant?.tokens?.reasoning || 0
    const apiCacheRead = lastAssistant?.tokens?.cache?.read || 0
    const apiCacheWrite = lastAssistant?.tokens?.cache?.write || 0
    breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite

    const userTextParts: string[] = []
    const toolInputParts: string[] = []
    const toolOutputParts: string[] = []
    const allToolIds = new Set<string>()
    const activeToolIds = new Set<string>()
    const prunedByMessageToolIds = new Set<string>()
    const allMessageIds = new Set<string>()

    let firstUserText = ""
    let foundFirstUser = false

    for (const msg of messages) {
        const ignoredUser = msg.info.role === "user" && isIgnoredUserMessage(msg)
        if (ignoredUser) continue

        allMessageIds.add(msg.info.id)
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        const compacted = isMessageCompacted(state, msg)
        const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id)
        const messagePruned = !!pruneEntry && pruneEntry.activeBlockIds.length > 0
        const messageActive = !compacted && !messagePruned

        breakdown.messageCount += 1
        messageStatuses.push(messageActive ? "active" : "pruned")

        for (const part of parts) {
            if (part.type === "tool") {
                const toolPart = part as ToolPart
                if (toolPart.callID) {
                    allToolIds.add(toolPart.callID)
                    if (!compacted) activeToolIds.add(toolPart.callID)
                    if (messagePruned) prunedByMessageToolIds.add(toolPart.callID)
                }

                const toolPruned = toolPart.callID && state.prune.tools.has(toolPart.callID)
                if (!compacted && !toolPruned) {
                    if (toolPart.state?.input) {
                        const inputText =
                            typeof toolPart.state.input === "string"
                                ? toolPart.state.input
                                : JSON.stringify(toolPart.state.input)
                        toolInputParts.push(inputText)
                    }
                    const outputText = extractCompletedToolOutput(toolPart)
                    if (outputText !== undefined) {
                        toolOutputParts.push(outputText)
                    }
                }
                continue
            }

            if (part.type === "text" && msg.info.role === "user" && !compacted) {
                const textPart = part as TextPart
                const text = textPart.text || ""
                userTextParts.push(text)
                if (!foundFirstUser) firstUserText += text
            }
        }

        if (msg.info.role === "user" && !foundFirstUser) {
            foundFirstUser = true
        }
    }

    const prunedByToolIds = new Set<string>()
    for (const toolID of allToolIds) {
        if (state.prune.tools.has(toolID)) prunedByToolIds.add(toolID)
    }

    const prunedToolIds = new Set<string>([...prunedByToolIds, ...prunedByMessageToolIds])
    breakdown.toolCount = allToolIds.size
    breakdown.toolsInContextCount = [...activeToolIds].filter(
        (id) => !prunedByToolIds.has(id),
    ).length
    breakdown.prunedToolCount = prunedToolIds.size

    for (const [messageID, entry] of state.prune.messages.byMessageId) {
        if (allMessageIds.has(messageID) && entry.activeBlockIds.length > 0) {
            breakdown.prunedMessageCount += 1
        }
    }

    const firstUserTokens = countTokens(firstUserText)
    breakdown.user = countTokens(userTextParts.join("\n"))
    const toolInputTokens = countTokens(toolInputParts.join("\n"))
    const toolOutputTokens = countTokens(toolOutputParts.join("\n"))

    if (firstAssistant) {
        const firstInput =
            (firstAssistant.tokens?.input || 0) +
            (firstAssistant.tokens?.cache?.read || 0) +
            (firstAssistant.tokens?.cache?.write || 0)
        breakdown.system = Math.max(0, firstInput - firstUserTokens)
    }

    breakdown.tools = toolInputTokens + toolOutputTokens
    breakdown.assistant = Math.max(
        0,
        breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
    )

    return { breakdown, messageStatuses }
}
