import assert from "node:assert/strict"
import test from "node:test"
import { computeInputBudget } from "../lib/messages/inject/utils"

test("computeInputBudget uses limit.input when defined (split-budget OpenAI models)", () => {
    // gpt-5.4-mini, gpt-5.5: 400K context, 272K input, 128K output
    assert.equal(computeInputBudget({ context: 400000, input: 272000, output: 128000 }), 272000)
    // gpt-5.4: 1.05M context, 922K input, 128K output
    assert.equal(computeInputBudget({ context: 1050000, input: 922000, output: 128000 }), 922000)
})

test("computeInputBudget subtracts output from context when limit.input is undefined (shared-pool models)", () => {
    // claude-opus-4-7: 1M context, 128K output, no explicit input limit
    assert.equal(computeInputBudget({ context: 1000000, output: 128000 }), 872000)
    // claude-haiku-4-5: 200K context, 64K output
    assert.equal(computeInputBudget({ context: 200000, output: 64000 }), 136000)
    // gpt-4o: 128K context, 16384 output
    assert.equal(computeInputBudget({ context: 128000, output: 16384 }), 111616)
})

test("computeInputBudget treats missing output as 0", () => {
    assert.equal(computeInputBudget({ context: 200000 }), 200000)
})

test("computeInputBudget returns undefined when context is unknown", () => {
    assert.equal(computeInputBudget({ context: 0, input: 100, output: 50 }), undefined)
})

test("computeInputBudget never returns negative when output exceeds context", () => {
    assert.equal(computeInputBudget({ context: 100, output: 200 }), 0)
})

test("computeInputBudget prefers explicit input over the context-minus-output fallback", () => {
    // If both `input` and `output` are present, `input` wins regardless of what
    // `context - output` would compute to. Defensive against models where the
    // numbers don't satisfy `input + output = context`.
    assert.equal(computeInputBudget({ context: 1000, input: 500, output: 200 }), 500)
})
