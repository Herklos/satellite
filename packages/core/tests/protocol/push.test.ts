import { describe, it, expect } from "vitest"
import { MemoryObjectStore } from "../helpers/memory-store.js"
import { push } from "../../src/protocol/push.js"
import type { StoredDocument } from "../../src/protocol/types.js"

describe("push", () => {
  it("first push with baseHash null succeeds", async () => {
    const store = new MemoryObjectStore()
    const result = await push(store, "col/doc1", { a: 1 }, null)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.timestamp).toBeTypeOf("number")
    }
  })

  it("first push with non-null baseHash fails", async () => {
    const store = new MemoryObjectStore()
    const result = await push(store, "col/doc1", { a: 1 }, "wrong-hash")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("hash_mismatch")
    }
  })

  it("second push with correct baseHash succeeds", async () => {
    const store = new MemoryObjectStore()
    const r1 = await push(store, "col/doc1", { a: 1 }, null)
    if (!r1.ok) throw new Error("first push failed")

    const r2 = await push(store, "col/doc1", { a: 2 }, r1.hash)
    expect(r2.ok).toBe(true)
  })

  it("second push with wrong baseHash fails", async () => {
    const store = new MemoryObjectStore()
    await push(store, "col/doc1", { a: 1 }, null)

    const r2 = await push(store, "col/doc1", { a: 2 }, "wrong-hash")
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.error).toBe("hash_mismatch")
    }
  })

  it("second push with null baseHash fails (document already exists)", async () => {
    const store = new MemoryObjectStore()
    await push(store, "col/doc1", { a: 1 }, null)

    const r2 = await push(store, "col/doc1", { a: 2 }, null)
    expect(r2.ok).toBe(false)
  })

  it("stores correct document format", async () => {
    const store = new MemoryObjectStore()
    await push(store, "col/doc1", { b: 2, a: 1 }, null)

    const raw = await store.getString("col/doc1")
    expect(raw).not.toBeNull()
    const doc = JSON.parse(raw!) as StoredDocument
    expect(doc.v).toBe(1)
    expect(doc.data).toEqual({ b: 2, a: 1 })
    expect(doc.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.timestamps.a).toBeTypeOf("number")
    expect(doc.timestamps.b).toBeTypeOf("number")
  })

  it("preserves timestamps for unchanged values", async () => {
    const store = new MemoryObjectStore()
    const r1 = await push(store, "col/doc1", { a: 1, b: 2 }, null)
    if (!r1.ok) throw new Error("first push failed")

    const raw1 = await store.getString("col/doc1")
    const doc1 = JSON.parse(raw1!) as StoredDocument
    const tsA = doc1.timestamps.a as number

    await push(store, "col/doc1", { a: 1, b: 3 }, r1.hash)

    const raw2 = await store.getString("col/doc1")
    const doc2 = JSON.parse(raw2!) as StoredDocument
    expect(doc2.timestamps.a).toBe(tsA)
    expect(doc2.timestamps.b).not.toBe(tsA)
  })
})
