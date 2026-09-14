import { describe, it, expect } from "vitest"
import { waitForRateLimit, RateLimitType } from "../src/utils/rate-limiter.js"

describe("rate-limiter", () => {
  it("allows requests within rate limit", async () => {
    await expect(waitForRateLimit(RateLimitType.Search)).resolves.toBeUndefined()
  })

  it("handles the USDA rate limit type", async () => {
    await expect(waitForRateLimit(RateLimitType.Usda)).resolves.toBeUndefined()
  })

  it("allows multiple requests sequentially", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(waitForRateLimit(RateLimitType.Search)).resolves.toBeUndefined()
    }
  })
})
