import assert from "node:assert/strict"
import test from "node:test"
import { resolveModelContextLimit } from "../lib/hooks"

// The v2 `session.hook("context")` event only carries a `Model.Ref`
// (id/providerID/variant) on `event.model` -- never the full `Model.Info`
// with `limit.context` that v1's chat hooks received directly. Percentage
// based `compress.maxContextLimit`/`minContextLimit` configs need this
// resolved out-of-band via `client.model.list()`.

test("resolveModelContextLimit resolves context window from client.model.list()", async () => {
    const client = {
        model: {
            list: async () => ({
                data: [
                    {
                        id: "grok-4.6",
                        modelID: "grok-4.6",
                        providerID: "xai",
                        limit: { context: 256_000, output: 8_000 },
                    },
                ],
            }),
        },
    }

    const limit = await resolveModelContextLimit(client, "xai", "grok-4.6")
    assert.equal(limit, 256_000)
})

test("resolveModelContextLimit caches by provider/model across calls", async () => {
    let callCount = 0
    const client = {
        model: {
            list: async () => {
                callCount += 1
                return {
                    data: [
                        {
                            id: "cache-test-model",
                            modelID: "cache-test-model",
                            providerID: "cache-test-provider",
                            limit: { context: 128_000, output: 4_000 },
                        },
                    ],
                }
            },
        },
    }

    const first = await resolveModelContextLimit(client, "cache-test-provider", "cache-test-model")
    const second = await resolveModelContextLimit(client, "cache-test-provider", "cache-test-model")

    assert.equal(first, 128_000)
    assert.equal(second, 128_000)
    assert.equal(callCount, 1)
})

test("resolveModelContextLimit returns undefined without a usable client", async () => {
    assert.equal(await resolveModelContextLimit(undefined, "xai", "grok-4.6"), undefined)
    assert.equal(await resolveModelContextLimit({}, "xai", "grok-4.6"), undefined)
    assert.equal(await resolveModelContextLimit({ model: {} }, "xai", "grok-4.6"), undefined)
})

test("resolveModelContextLimit returns undefined when provider or model id is missing", async () => {
    const client = { model: { list: async () => ({ data: [] }) } }
    assert.equal(await resolveModelContextLimit(client, undefined, "grok-4.6"), undefined)
    assert.equal(await resolveModelContextLimit(client, "xai", undefined), undefined)
})

test("resolveModelContextLimit swallows client errors", async () => {
    const client = {
        model: {
            list: async () => {
                throw new Error("network down")
            },
        },
    }

    const limit = await resolveModelContextLimit(
        client,
        "unreachable-provider",
        "unreachable-model",
    )
    assert.equal(limit, undefined)
})
