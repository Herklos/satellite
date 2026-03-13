import { describe, it, expect, vi, beforeEach } from "vitest"
import { SatelliteClient } from "../src/client.js"
import { SyncManager } from "../src/sync.js"
import { createSatelliteStore } from "../src/bindings/zustand.js"
import type { PullResponse, PushSuccess } from "../src/types.js"

function mockClient(overrides: {
  pull?: (path: string, checkpoint?: number) => Promise<PullResponse>
  push?: (path: string, data: Record<string, unknown>, baseHash: string | null, sig?: string) => Promise<PushSuccess>
} = {}) {
  return {
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
}

function createTestStore(clientOverrides?: Parameters<typeof mockClient>[0]) {
  const client = mockClient(clientOverrides)
  const syncManager = new SyncManager({
    client,
    pullPath: "/pull/test",
    pushPath: "/push/test",
  })

  const store = createSatelliteStore({
    name: "test",
    syncManager,
    storage: false,
  })

  return { store, client, syncManager }
}

describe("createSatelliteStore", () => {
  it("has correct initial state", () => {
    const { store } = createTestStore()
    const state = store.getState()

    expect(state.data).toEqual({})
    expect(state.syncing).toBe(false)
    expect(state.online).toBe(true)
    expect(state.dirty).toBe(false)
    expect(state.error).toBeNull()
  })

  it("pull fetches remote data into store", async () => {
    const { store } = createTestStore()

    await store.getState().pull()

    const state = store.getState()
    expect(state.data).toEqual({ key: "value" })
    expect(state.syncing).toBe(false)
    expect(state.error).toBeNull()
  })

  it("pull sets error on failure", async () => {
    const { store } = createTestStore({
      pull: async () => { throw new Error("network down") },
    })

    await store.getState().pull()

    const state = store.getState()
    expect(state.error).toBe("network down")
    expect(state.syncing).toBe(false)
    expect(state.data).toEqual({})
  })

  it("set applies optimistic local write and marks dirty", async () => {
    const pushFn = vi.fn(async () => ({ hash: "h1", timestamp: 100 }))
    const { store } = createTestStore({ push: pushFn })

    store.getState().set((d) => ({ ...d, theme: "dark" }))

    const state = store.getState()
    expect(state.data).toEqual({ theme: "dark" })
    expect(state.dirty).toBe(true)
  })

  it("set triggers background flush when online", async () => {
    const pushFn = vi.fn(async () => ({ hash: "h1", timestamp: 100 }))
    const { store } = createTestStore({ push: pushFn })

    store.getState().set((d) => ({ ...d, theme: "dark" }))

    // Wait for the async flush to complete
    await vi.waitFor(() => {
      expect(pushFn).toHaveBeenCalled()
    })
  })

  it("set does not flush when offline", async () => {
    const pushFn = vi.fn(async () => ({ hash: "h1", timestamp: 100 }))
    const { store } = createTestStore({ push: pushFn })

    store.getState().setOnline(false)
    store.getState().set((d) => ({ ...d, theme: "dark" }))

    // Give it a tick to ensure no async call
    await new Promise((r) => setTimeout(r, 10))
    expect(pushFn).not.toHaveBeenCalled()
    expect(store.getState().dirty).toBe(true)
  })

  it("flush pushes data and clears dirty flag", async () => {
    const pushFn = vi.fn(async () => ({ hash: "h1", timestamp: 100 }))
    const { store } = createTestStore({ push: pushFn })

    // Go offline, write, then manually flush
    store.getState().setOnline(false)
    store.getState().set((d) => ({ ...d, x: 1 }))
    store.getState().setOnline(true)

    await vi.waitFor(() => {
      expect(store.getState().dirty).toBe(false)
    })
    expect(pushFn).toHaveBeenCalled()
  })

  it("flush sets error on failure but keeps data", async () => {
    const pushFn = vi.fn(async () => { throw new Error("server error") })
    const { store } = createTestStore({ push: pushFn })

    store.getState().setOnline(false)
    store.getState().set((d) => ({ ...d, important: true }))
    expect(store.getState().dirty).toBe(true)

    store.getState().setOnline(true)

    await vi.waitFor(() => {
      expect(store.getState().error).toBe("server error")
    })
    // Data and dirty flag preserved for retry
    expect(store.getState().data).toEqual({ important: true })
    expect(store.getState().dirty).toBe(true)
  })

  it("setOnline flushes dirty data when going online", async () => {
    const pushFn = vi.fn(async () => ({ hash: "h1", timestamp: 100 }))
    const { store } = createTestStore({ push: pushFn })

    store.getState().setOnline(false)
    store.getState().set((d) => ({ ...d, queued: true }))

    expect(pushFn).not.toHaveBeenCalled()

    store.getState().setOnline(true)

    await vi.waitFor(() => {
      expect(pushFn).toHaveBeenCalled()
    })
  })

  it("subscribe reacts to state changes", async () => {
    const { store } = createTestStore()
    const values: unknown[] = []

    store.subscribe((state) => {
      values.push(state.data)
    })

    store.getState().set((d) => ({ ...d, a: 1 }))

    expect(values.length).toBeGreaterThanOrEqual(1)
    expect(values).toContainEqual({ a: 1 })
  })
})
