import { describe, it, expect } from "vitest"
import { stableStringify, computeHash } from "../../src/protocol/hash.js"

describe("stableStringify", () => {
  it("sorts object keys", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it("sorts nested object keys", () => {
    expect(stableStringify({ z: { b: 2, a: 1 }, a: 0 })).toBe('{"a":0,"z":{"a":1,"b":2}}')
  })

  it("handles arrays (no sorting)", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]")
  })

  it("handles null", () => {
    expect(stableStringify(null)).toBe("null")
  })

  it("handles strings", () => {
    expect(stableStringify("hello")).toBe('"hello"')
  })

  it("handles booleans", () => {
    expect(stableStringify(true)).toBe("true")
  })

  it("handles empty object", () => {
    expect(stableStringify({})).toBe("{}")
  })

  it("is deterministic regardless of key insertion order", () => {
    const a = { x: 1, y: 2, z: 3 }
    const b = { z: 3, x: 1, y: 2 }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })
})

describe("computeHash", () => {
  it("returns a 64-char hex string", async () => {
    const hash = await computeHash({ hello: "world" })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("same data produces same hash regardless of key order", async () => {
    const h1 = await computeHash({ a: 1, b: 2 })
    const h2 = await computeHash({ b: 2, a: 1 })
    expect(h1).toBe(h2)
  })

  it("different data produces different hash", async () => {
    const h1 = await computeHash({ a: 1 })
    const h2 = await computeHash({ a: 2 })
    expect(h1).not.toBe(h2)
  })
})
