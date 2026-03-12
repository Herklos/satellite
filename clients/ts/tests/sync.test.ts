import { describe, it, expect, vi } from "vitest"
import { SatelliteClient } from "../src/client.js"
import { SyncManager } from "../src/sync.js"
import type { PullResponse, PushSuccess } from "../src/types.js"
import type { StorageProvider } from "../src/storage.js"

function mockClient(overrides: {
  pull?: (path: string, checkpoint?: number) => Promise<PullResponse>
  push?: (path: string, data: Record<string, unknown>, baseHash: string | null, sig?: string) => Promise<PushSuccess>
} = {}) {
  const client = {
    pull: overrides.pull ?? vi.fn(async () => ({
      data: { key: "value" },
      hash: "abc123",
      timestamp: 1000,
    })),
    push: overrides.push ?? vi.fn(async () => ({
      hash: "def456",
      timestamp: 2000,
    })),
  } as unknown as SatelliteClient

  return client
}

function mockStorage(data: Record<string, string> = {}): StorageProvider {
  const store = new Map(Object.entries(data))
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
  }
}

describe("SyncManager", () => {
  it("pull stores data, hash, and checkpoint", async () => {
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
    })

    const result = await sync.pull()
    expect(result.data).toEqual({ key: "value" })
    expect(sync.getData()).toEqual({ key: "value" })
    expect(sync.getHash()).toBe("abc123")
    expect(sync.getCheckpoint()).toBe(1000)
  })

  it("push sends data and updates state", async () => {
    const pushFn = vi.fn(async () => ({ hash: "new-hash", timestamp: 3000 }))
    const client = mockClient({ push: pushFn as any })
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
    })

    const result = await sync.push({ newKey: "newValue" })
    expect(result.hash).toBe("new-hash")
    expect(result.timestamp).toBe(3000)
    expect(sync.getHash()).toBe("new-hash")
    expect(pushFn).toHaveBeenCalledWith(
      "/push/test",
      { newKey: "newValue" },
      null,
      undefined
    )
  })

  it("incremental pull merges into local data", async () => {
    let callCount = 0
    const client = mockClient({
      pull: async () => {
        callCount++
        if (callCount === 1) {
          return { data: { a: 1, b: 2 }, hash: "h1", timestamp: 100 }
        }
        return { data: { b: 3 }, hash: "h2", timestamp: 200 }
      },
    })

    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
    })

    await sync.pull() // full pull
    expect(sync.getData()).toEqual({ a: 1, b: 2 })

    await sync.pull() // incremental — should merge
    expect(sync.getData()).toEqual({ a: 1, b: 3 })
  })

  it("update does pull-modify-push", async () => {
    const pushFn = vi.fn(async () => ({ hash: "updated", timestamp: 500 }))
    const client = mockClient({ push: pushFn as any })
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
    })

    const result = await sync.update((data) => ({
      ...data,
      extra: "field",
    }))

    expect(result.hash).toBe("updated")
    expect(pushFn).toHaveBeenCalled()
  })
})

describe("SyncManager persistence", () => {
  it("persists state after pull", async () => {
    const storage = mockStorage()
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
    })

    await sync.pull()
    expect(storage.set).toHaveBeenCalledWith("lastHash", "abc123")
    expect(storage.set).toHaveBeenCalledWith("lastCheckpoint", "1000")
    expect(storage.set).toHaveBeenCalledWith(
      "localData",
      JSON.stringify({ key: "value" })
    )
  })

  it("persists state after push", async () => {
    const storage = mockStorage()
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
    })

    await sync.push({ foo: "bar" })
    expect(storage.set).toHaveBeenCalledWith("lastHash", "def456")
    expect(storage.set).toHaveBeenCalledWith("lastCheckpoint", "2000")
    expect(storage.set).toHaveBeenCalledWith(
      "localData",
      JSON.stringify({ foo: "bar" })
    )
  })

  it("restore loads state from storage", async () => {
    const storage = mockStorage({
      lastHash: "saved-hash",
      lastCheckpoint: "5000",
      localData: JSON.stringify({ restored: true }),
    })
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
    })

    const found = await sync.restore()
    expect(found).toBe(true)
    expect(sync.getHash()).toBe("saved-hash")
    expect(sync.getCheckpoint()).toBe(5000)
    expect(sync.getData()).toEqual({ restored: true })
  })

  it("restore returns false when storage is empty", async () => {
    const storage = mockStorage()
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
    })

    const found = await sync.restore()
    expect(found).toBe(false)
    expect(sync.getHash()).toBeNull()
  })

  it("works without storage (backward compat)", async () => {
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
    })

    // Should not throw — no storage configured
    await sync.pull()
    expect(sync.getData()).toEqual({ key: "value" })
    const found = await sync.restore()
    expect(found).toBe(false)
  })

  it("persists encrypted data when persistEncrypted is true", async () => {
    const storage = mockStorage()
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
      encryptionSecret: "test-secret",
      encryptionSalt: "test-salt",
      persistEncrypted: true,
    })

    await sync.pull()

    // localData should be stored encrypted (wrapped in _encrypted key)
    const storedData = (storage.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === "localData"
    )
    const parsed = JSON.parse(storedData![1])
    expect(parsed).toHaveProperty("_encrypted")
    expect(parsed._encrypted).toBeTypeOf("string")
  })

  it("restores encrypted persisted data", async () => {
    // First: persist encrypted
    const storage = mockStorage()
    const client = mockClient({
      pull: async () => ({ data: { secret: "data" }, hash: "h1", timestamp: 100 }),
    })
    const sync1 = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
      encryptionSecret: "test-secret",
      encryptionSalt: "test-salt",
      persistEncrypted: true,
    })
    await sync1.pull()

    // Second: restore from same storage
    const sync2 = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
      encryptionSecret: "test-secret",
      encryptionSalt: "test-salt",
      persistEncrypted: true,
    })
    const found = await sync2.restore()
    expect(found).toBe(true)
    expect(sync2.getData()).toEqual({ secret: "data" })
  })

  it("persists plaintext by default even with encryption enabled", async () => {
    const storage = mockStorage()
    const client = mockClient()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/test",
      pushPath: "/push/test",
      storage,
      encryptionSecret: "test-secret",
      encryptionSalt: "test-salt",
      // persistEncrypted defaults to false
    })

    await sync.pull()

    const storedData = (storage.set as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0] === "localData"
    )
    const parsed = JSON.parse(storedData![1])
    // Should be plaintext, not encrypted wrapper
    expect(parsed).toEqual({ key: "value" })
    expect(parsed).not.toHaveProperty("_encrypted")
  })
})
