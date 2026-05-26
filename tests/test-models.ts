import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { commandCodeModelsFromApiResponse } from "../src/models.ts"

describe("commandCodeModelsFromApiResponse()", () => {
  it("converts the Provider API model list to pi models", () => {
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        {
          id: "Qwen/Qwen3.7-Max",
          object: "model",
          created: 1779824324,
          owned_by: "command-code",
          name: "Qwen 3.7 Max",
          context_length: 1_000_000,
        },
      ],
    })

    assert.deepEqual(models, [
      {
        id: "Qwen/Qwen3.7-Max",
        name: "Qwen 3.7 Max (CC)",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      },
    ])
  })

  it("rejects unexpected API shapes", () => {
    assert.throws(() => commandCodeModelsFromApiResponse({ object: "list", data: [{}] }))
  })
})
