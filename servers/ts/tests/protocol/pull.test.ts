import { describe, it, expect } from "vitest"
import { MemoryObjectStore } from "../helpers/memory-store.js"
import { pull } from "../../src/protocol/pull.js"
import { push } from "../../src/protocol/push.js"

describe("pull", () => {
  it("returns empty data when no document exists", async () => {
    const store = new MemoryObjectStore()
    const result = await pull(store, "col/doc1")
    expect(result.data).toEqual({})
    expect(result.hash).toBe("")
    expect(result.timestamp).toBeTypeOf("number")
  })

  it("returns full data after push", async () => {
    const store = new MemoryObjectStore()
    const data = { "sig-1": { payload: { value: 42 } } }
    await push(store, "col/doc1", data, null)

    const result = await pull(store, "col/doc1")
    expect(result.data).toEqual(data)
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.timestamp).toBeTypeOf("number")
  })

  it("returns filtered data with checkpoint", async () => {
    const store = new MemoryObjectStore()

    const data1 = { "sig-1": { payload: { value: 1 } } }
    const r1 = await push(store, "col/doc1", data1, null)
    if (!r1.ok) throw new Error("push failed")
    const checkpoint = r1.timestamp

    const data2 = { "sig-1": { payload: { value: 1 } }, "sig-2": { payload: { value: 2 } } }
    await push(store, "col/doc1", data2, r1.hash)

    const result = await pull(store, "col/doc1", checkpoint)
    expect(result.data["sig-2"]).toBeDefined()
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns full data when timestamps are empty (client-encrypted)", async () => {
    const store = new MemoryObjectStore()

    // First push with skipTimestamps (simulating E2E encrypted collection)
    const r1 = await push(store, "col/doc1", { _encrypted: "v1" }, null, undefined, true)
    if (!r1.ok) throw new Error("push failed")
    const checkpoint = r1.timestamp

    // Second push
    await push(store, "col/doc1", { _encrypted: "v2" }, r1.hash, undefined, true)

    // Pull with checkpoint should still return full data since timestamps are empty
    const result = await pull(store, "col/doc1", checkpoint)
    expect(result.data).toEqual({ _encrypted: "v2" })
  })

  it("returns full data when checkpoint is 0", async () => {
    const store = new MemoryObjectStore()
    const data = { "sig-1": { payload: { value: 42 } } }
    await push(store, "col/doc1", data, null)

    const result = await pull(store, "col/doc1", 0)
    expect(result.data).toEqual(data)
  })
})
