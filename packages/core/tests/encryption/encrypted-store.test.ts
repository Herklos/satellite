import { describe, it, expect } from "vitest"
import { MemoryObjectStore } from "../helpers/memory-store.js"
import { EncryptedObjectStore } from "../../src/encryption/encrypted-store.js"

describe("EncryptedObjectStore", () => {
  it("round-trips: getString returns original value after put", async () => {
    const inner = new MemoryObjectStore()
    const store = new EncryptedObjectStore(inner, "server-secret", "user-id")

    await store.put("test/key", '{"hello":"world"}')
    const result = await store.getString("test/key")
    expect(result).toBe('{"hello":"world"}')
  })

  it("data is encrypted at rest", async () => {
    const inner = new MemoryObjectStore()
    const store = new EncryptedObjectStore(inner, "server-secret", "user-id")

    const plaintext = '{"secret":"data","balance":1000}'
    await store.put("test/key", plaintext)

    const raw = await inner.getString("test/key")
    expect(raw).not.toBeNull()
    expect(raw).not.toBe(plaintext)
    expect(raw).not.toContain("secret")
    expect(raw).not.toContain("balance")
  })

  it("different salts produce different ciphertexts", async () => {
    const inner = new MemoryObjectStore()
    const store1 = new EncryptedObjectStore(inner, "secret", "user-1")
    const store2 = new EncryptedObjectStore(inner, "secret", "user-2")

    await store1.put("key1", "same-data")
    await store2.put("key2", "same-data")

    const raw1 = await inner.getString("key1")
    const raw2 = await inner.getString("key2")
    expect(raw1).not.toBe(raw2)
  })

  it("wrong key cannot decrypt", async () => {
    const inner = new MemoryObjectStore()
    const store1 = new EncryptedObjectStore(inner, "secret", "user-1")
    const store2 = new EncryptedObjectStore(inner, "secret", "user-2")

    await store1.put("test/key", "sensitive")
    await expect(store2.getString("test/key")).rejects.toThrow()
  })

  it("getString returns null for missing keys", async () => {
    const inner = new MemoryObjectStore()
    const store = new EncryptedObjectStore(inner, "secret", "user")

    expect(await store.getString("missing")).toBeNull()
  })

  it("list delegates to inner store", async () => {
    const inner = new MemoryObjectStore()
    const store = new EncryptedObjectStore(inner, "secret", "user")

    await store.put("prefix/a", "data-a")
    await store.put("prefix/b", "data-b")
    await store.put("other/c", "data-c")

    const keys = await store.list("prefix/")
    expect(keys).toHaveLength(2)
    expect(keys).toContain("prefix/a")
    expect(keys).toContain("prefix/b")
  })

  it("del and delMany delegate to inner store", async () => {
    const inner = new MemoryObjectStore()
    const store = new EncryptedObjectStore(inner, "secret", "user")

    await store.put("a", "1")
    await store.put("b", "2")
    await store.put("c", "3")

    await store.del("a")
    expect(await inner.getString("a")).toBeNull()

    await store.delMany(["b", "c"])
    expect(await inner.getString("b")).toBeNull()
    expect(await inner.getString("c")).toBeNull()
  })
})
