import assert from "node:assert/strict"
import test from "node:test"
import { Logger } from "../lib/logger"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressionBlock } from "../lib/state"
import { syncCompressionBlocks } from "../lib/messages/sync"
import { prune } from "../lib/messages/prune"
import type { PluginConfig } from "../lib/config"
import { saveSessionState, loadSessionState } from "../lib/state/persistence"
import { existsSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"

function msg(id: string, role: "user" | "assistant" = "user"): WithParts {
    return {
        info: {
            id,
            role,
            sessionID: "ses-sync-test",
            time: { created: 1 },
        },
        parts: [
            {
                id: `${id}-part`,
                messageID: id,
                sessionID: "ses-sync-test",
                type: "text" as const,
                text: `content of ${id}`,
            },
        ],
    } as unknown as WithParts
}

function buildBlock(
    anchorMessageId: string,
    compressMessageId: string,
    rangeMessageIds: string[],
    summary: string,
): CompressionBlock {
    return {
        blockId: 1,
        runId: 1,
        active: true,
        deactivatedByUser: false,
        compressedTokens: 1000,
        summaryTokens: summary.length,
        mode: "range",
        topic: "sync-test",
        batchTopic: "sync-test",
        startId: "m0001",
        endId: "m0009",
        anchorMessageId,
        compressMessageId,
        includedBlockIds: [],
        consumedBlockIds: [],
        parentBlockIds: [],
        directMessageIds: rangeMessageIds,
        directToolIds: [],
        effectiveMessageIds: rangeMessageIds,
        effectiveToolIds: [],
        createdAt: 1,
        summary,
    }
}

function buildConfig(): PluginConfig {
    return {
        enabled: true,
        debug: false,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: { enabled: true, protectedTools: [] },
        manualMode: { enabled: false, automaticStrategies: true },
        turnProtection: { enabled: false, turns: 4 },
        experimental: { allowSubAgents: false, customPrompts: false },
        protectedFilePatterns: [],
        compress: {
            mode: "range",
            permission: "allow",
            showCompression: false,
            summaryBuffer: true,
            maxContextLimit: "85%",
            minContextLimit: "60%",
            nudgeFrequency: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: ["task"],
            protectTags: false,
            protectUserMessages: false,
        },
        strategies: {
            deduplication: { enabled: true, protectedTools: [] },
            purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
        },
    }
}

test("syncCompressionBlocks keeps block active via anchor when compressMessageId is missing", () => {
    const state = createSessionState()
    const anchorMsgId = "msg-anchor"
    const rangeMsgIds = ["msg-1", "msg-2", "msg-3"]
    const messages = [msg(anchorMsgId), ...rangeMsgIds.map((id) => msg(id))]

    // compressMessageId 指向不存在的消息（模拟被标记 ignored 未持久化）
    const block = buildBlock(anchorMsgId, "msg-compress-missing", rangeMsgIds, "summary text")
    state.prune.messages.blocksById.set(1, block)
    for (const id of rangeMsgIds) {
        state.prune.messages.byMessageId.set(id, { allBlockIds: [1], activeBlockIds: [1] })
    }

    syncCompressionBlocks(state, new Logger(false), messages)

    assert.equal(block.active, true)
    assert.equal(state.prune.messages.activeBlockIds.has(1), true)
    assert.equal(state.prune.messages.activeByAnchorMessageId.get(anchorMsgId), 1)
})

test("syncCompressionBlocks still deactivates block when both origin and anchor are missing", () => {
    const state = createSessionState()
    const rangeMsgIds = ["msg-1"]
    const messages = rangeMsgIds.map((id) => msg(id))

    const block = buildBlock("msg-anchor-missing", "msg-compress-missing", rangeMsgIds, "summary")
    state.prune.messages.blocksById.set(1, block)
    state.prune.messages.byMessageId.set("msg-1", { allBlockIds: [1], activeBlockIds: [1] })

    syncCompressionBlocks(state, new Logger(false), messages)

    assert.equal(block.active, false)
    assert.equal(state.prune.messages.activeBlockIds.has(1), false)
})

test("prune injects compressed summary into LLM context after sync keeps block active", () => {
    const state = createSessionState()
    const anchorMsgId = "msg-anchor"
    const rangeMsgIds = ["msg-1", "msg-2", "msg-3"]
    const summary = "[Compressed conversation section]\n压缩后的关键摘要内容。"
    const messages = [msg(anchorMsgId), ...rangeMsgIds.map((id) => msg(id))]

    const block = buildBlock(anchorMsgId, "msg-compress-missing", rangeMsgIds, summary)
    state.prune.messages.blocksById.set(1, block)
    for (const id of rangeMsgIds) {
        state.prune.messages.byMessageId.set(id, { allBlockIds: [1], activeBlockIds: [1] })
    }

    syncCompressionBlocks(state, new Logger(false), messages)
    prune(state, new Logger(false), buildConfig(), messages)

    // 摘要必须实际注入（LLM 能读到被压缩的内容）
    const joined = messages
        .map((m) =>
            (m.parts ?? [])
                .map((p: any) => (typeof p.text === "string" ? p.text : ""))
                .join(" "),
        )
        .join("\n")
    assert.ok(
        joined.includes("[Compressed conversation section]"),
        `expected summary marker, got: ${joined.slice(0, 300)}`,
    )
    assert.ok(joined.includes("压缩后的关键摘要内容"), "summary content must reach the LLM")

    // 范围内的原始消息被摘要替换（不发送原文）
    for (const id of rangeMsgIds) {
        assert.equal(
            messages.some((m) => m.info.id === id),
            false,
            `compressed message ${id} should be removed`,
        )
    }
    // 锚点消息保留
    assert.ok(messages.some((m) => m.info.id === anchorMsgId))
})

test("modelContextLimit is persisted and restored across restarts", async () => {
    // 回归：重启后第一轮 chat.message hook 先于 system.prompt hook 运行，
    // modelContextLimit 若未持久化则阈值无法按百分比解析。
    const sid = "ses-persist-roundtrip"
    const filePath = join(
        process.env.XDG_DATA_HOME || join(process.env.USERPROFILE || "", ".local", "share"),
        "opencode",
        "storage",
        "plugin",
        "dcp",
        `${sid}.json`,
    )
    try {
        const logger = new Logger(false)

        const state = createSessionState()
        state.sessionId = sid
        state.modelContextLimit = 1000000 // 1M，如 deepseek-v4-flash / kimi k3
        await saveSessionState(state, logger)

        // 模拟重启：从磁盘加载（modelContextLimit 必须恢复）
        const loaded = await loadSessionState(sid, logger)
        assert.ok(loaded !== null)
        assert.equal(loaded.modelContextLimit, 1000000)

        // 持久化文件里确实包含该字段（而非仅内存）
        assert.equal(existsSync(filePath), true)
        const raw = JSON.parse(readFileSync(filePath, "utf-8"))
        assert.equal(raw.modelContextLimit, 1000000)
    } finally {
        if (existsSync(filePath)) {
            rmSync(filePath, { force: true })
        }
    }
})
