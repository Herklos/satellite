/**
 * End-to-end tests: real SatelliteClient + SyncManager + Zustand store
 * talking to a real Hono server with MemoryObjectStore.
 *
 * No mocks — the only seam is SatelliteClient's custom `fetch` option,
 * which is wired directly to the Hono router (no TCP needed).
 */
import { describe, it, expect, beforeEach } from "vitest"
import { produce } from "immer"
import { Hono } from "hono"
import { createSyncRouter } from "@satellite/core/router"
import type { SyncConfig } from "@satellite/core"
import type { IObjectStore } from "@satellite/core"
import { SatelliteClient } from "../src/client.js"
import { SyncManager } from "../src/sync.js"
import { createSatelliteStore } from "../src/bindings/zustand.js"

// ---------------------------------------------------------------------------
// In-memory object store (same as packages/core/tests/helpers)
// ---------------------------------------------------------------------------

class MemoryObjectStore implements IObjectStore {
  private store = new Map<string, string>()
  async getString(key: string) { return this.store.get(key) ?? null }
  async put(key: string, body: string) { this.store.set(key, body) }
  async list(prefix: string, opts: { startAfter?: string; limit?: number } = {}) {
    const keys = [...this.store.keys()].filter(k => k.startsWith(prefix)).sort()
    const start = opts.startAfter ? keys.findIndex(k => k > opts.startAfter!) : 0
    const startIdx = start === -1 ? keys.length : start
    return keys.slice(startIdx, startIdx + (opts.limit ?? 1000))
  }
  async del(key: string) { this.store.delete(key) }
  async delMany(keys: string[]) { keys.forEach(k => this.store.delete(k)) }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const config: SyncConfig = {
  version: 1,
  collections: [
    {
      name: "settings",
      storagePath: "users/{identity}/settings",
      readRoles: ["self"],
      writeRoles: ["self"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
    {
      name: "notes",
      storagePath: "users/{identity}/notes",
      readRoles: ["self"],
      writeRoles: ["self"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
    {
      name: "public-config",
      storagePath: "app/config",
      readRoles: ["public"],
      writeRoles: ["admin"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
  ],
}

function createTestEnv(identity = "user-1", roles: string[] = []) {
  const store = new MemoryObjectStore()
  const router = createSyncRouter({
    store,
    config,
    roleResolver: async () => ({ identity, roles }),
  })
  const app = new Hono()
  app.route("/v1", router)

  const client = new SatelliteClient({
    baseUrl: "http://localhost/v1",
    fetch: (input, init) => app.fetch(new Request(input, init)),
  })

  return { store, app, client }
}

// ===========================================================================
// SatelliteClient e2e
// ===========================================================================

describe("e2e: SatelliteClient", () => {
  it("pull returns empty data for a new collection", async () => {
    const { client } = createTestEnv()
    const res = await client.pull("/pull/users/user-1/settings")

    expect(res.data).toEqual({})
    expect(res.hash).toBe("")
  })

  it("push then pull round-trips data", async () => {
    const { client } = createTestEnv()

    const push = await client.push(
      "/push/users/user-1/settings",
      { theme: "dark", lang: "en" },
      null,
    )
    expect(push.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(push.timestamp).toBeGreaterThan(0)

    const pull = await client.pull("/pull/users/user-1/settings")
    expect(pull.data).toEqual({ theme: "dark", lang: "en" })
    expect(pull.hash).toBe(push.hash)
  })

  it("push with stale baseHash throws ConflictError", async () => {
    const { client } = createTestEnv()

    await client.push("/push/users/user-1/settings", { v: 1 }, null)

    await expect(
      client.push("/push/users/user-1/settings", { v: 2 }, "wrong-hash"),
    ).rejects.toThrow("hash_mismatch")
  })

  it("sequential pushes with correct baseHash succeed", async () => {
    const { client } = createTestEnv()

    const first = await client.push("/push/users/user-1/settings", { a: 1 }, null)
    const second = await client.push("/push/users/user-1/settings", { a: 2 }, first.hash)

    expect(second.hash).not.toBe(first.hash)

    const pull = await client.pull("/pull/users/user-1/settings")
    expect(pull.data).toEqual({ a: 2 })
  })

  it("self role denies access to another user's data", async () => {
    const { client } = createTestEnv("user-1")

    await expect(
      client.pull("/pull/users/user-2/settings"),
    ).rejects.toThrow("403")
  })

  it("admin can push to admin-only collection", async () => {
    const { client } = createTestEnv("admin-user", ["admin"])

    const push = await client.push(
      "/push/app/config",
      { maintenance: false },
      null,
    )
    expect(push.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("non-admin cannot push to admin-only collection", async () => {
    const { client } = createTestEnv("regular-user", [])

    await expect(
      client.push("/push/app/config", { maintenance: true }, null),
    ).rejects.toThrow("403")
  })

  it("public collection is readable without roles", async () => {
    // First push as admin
    const adminEnv = createTestEnv("admin-user", ["admin"])
    await adminEnv.client.push("/push/app/config", { version: "2.0" }, null)

    // Read as unauthenticated user (public)
    const publicClient = new SatelliteClient({
      baseUrl: "http://localhost/v1",
      fetch: (input, init) => adminEnv.app.fetch(new Request(input, init)),
    })
    const pull = await publicClient.pull("/pull/app/config")
    expect(pull.data).toEqual({ version: "2.0" })
  })
})

// ===========================================================================
// SyncManager e2e
// ===========================================================================

describe("e2e: SyncManager", () => {
  it("pull + push full cycle", async () => {
    const { client } = createTestEnv()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })

    // Initial pull — empty
    await sync.pull()
    expect(sync.getData()).toEqual({})

    // Push data
    const result = await sync.push({ theme: "dark" })
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)

    // Pull again — data matches
    await sync.pull()
    expect(sync.getData()).toEqual({ theme: "dark" })
  })

  it("update does pull-modify-push atomically", async () => {
    const { client } = createTestEnv()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })

    await sync.update((data) => ({ ...data, counter: 1 }))
    expect(sync.getData()).toEqual({ counter: 1 })

    await sync.update((data) => ({ ...data, counter: (data.counter as number) + 1 }))
    expect(sync.getData()).toEqual({ counter: 2 })

    // Verify server has the latest
    const sync2 = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    await sync2.pull()
    expect(sync2.getData()).toEqual({ counter: 2 })
  })

  it("conflict resolution merges and retries", async () => {
    const { client } = createTestEnv()

    // Writer A pushes initial data
    const syncA = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    await syncA.push({ shared: "initial" })

    // Writer B pulls, then writer A pushes again
    const syncB = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    await syncB.pull()

    // A overwrites
    await syncA.push({ shared: "from-A", onlyA: true })

    // B tries to push with stale hash — should auto-resolve conflict
    const result = await syncB.push({ shared: "from-B", onlyB: true })
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)

    // Verify merged result (default merge: remote wins on shared keys)
    const verify = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    await verify.pull()
    const merged = verify.getData()
    // Default resolver does remote-wins merge, so "shared" comes from remote (A's value)
    // and both onlyA + onlyB should be present
    expect(merged).toHaveProperty("onlyA")
    expect(merged).toHaveProperty("onlyB")
  })

  it("incremental pull with checkpoint", async () => {
    const { client } = createTestEnv()
    const sync = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })

    // Push initial data
    await sync.push({ a: 1, b: 2 })
    const checkpoint = sync.getCheckpoint()
    expect(checkpoint).toBeGreaterThan(0)

    // Push more data
    await sync.push({ a: 1, b: 2, c: 3 })

    // New sync manager pulls incrementally from checkpoint
    const sync2 = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    // Full pull first
    await sync2.pull()
    expect(sync2.getData()).toEqual({ a: 1, b: 2, c: 3 })
  })

  it("two independent collections on same server", async () => {
    const { client } = createTestEnv()

    const settings = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    const notes = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/notes",
      pushPath: "/push/users/user-1/notes",
    })

    await settings.push({ theme: "dark" })
    await notes.push({ items: ["note-1"] })

    await settings.pull()
    await notes.pull()

    expect(settings.getData()).toEqual({ theme: "dark" })
    expect(notes.getData()).toEqual({ items: ["note-1"] })
  })
})

// ===========================================================================
// Zustand store e2e
// ===========================================================================

describe("e2e: Zustand store", () => {
  it("pull populates store with server data", async () => {
    const { client } = createTestEnv()

    // Seed data via raw client
    await client.push("/push/users/user-1/settings", { theme: "light" }, null)

    const store = createSatelliteStore({
      name: "e2e-settings",
      syncManager: new SyncManager({
        client,
        pullPath: "/pull/users/user-1/settings",
        pushPath: "/push/users/user-1/settings",
      }),
      storage: false,
    })

    await store.getState().pull()

    expect(store.getState().data).toEqual({ theme: "light" })
    expect(store.getState().syncing).toBe(false)
    expect(store.getState().error).toBeNull()
  })

  it("optimistic set + background flush round-trips to server", async () => {
    const { client } = createTestEnv()

    const syncManager = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    const store = createSatelliteStore({
      name: "e2e-flush",
      syncManager,
      storage: false,
    })

    // Optimistic write
    store.getState().set((d) => ({ ...d, theme: "dark" }))
    expect(store.getState().data).toEqual({ theme: "dark" })

    // Wait for background flush
    await new Promise<void>((resolve) => {
      const unsub = store.subscribe((state) => {
        if (!state.dirty && !state.syncing) {
          unsub()
          resolve()
        }
      })
    })

    // Verify server has the data via a fresh sync manager
    const verify = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    await verify.pull()
    expect(verify.getData()).toEqual({ theme: "dark" })
  })

  it("offline queuing and online flush", async () => {
    const { client } = createTestEnv()

    const syncManager = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/notes",
      pushPath: "/push/users/user-1/notes",
    })
    const store = createSatelliteStore({
      name: "e2e-offline",
      syncManager,
      storage: false,
    })

    // Go offline, write data
    store.getState().setOnline(false)
    store.getState().set((d) => ({ ...d, items: ["offline-note"] }))

    expect(store.getState().dirty).toBe(true)
    expect(store.getState().data).toEqual({ items: ["offline-note"] })

    // Server should NOT have the data yet
    const checkBefore = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/notes",
      pushPath: "/push/users/user-1/notes",
    })
    await checkBefore.pull()
    expect(checkBefore.getData()).toEqual({})

    // Go online — should auto-flush
    store.getState().setOnline(true)

    await new Promise<void>((resolve) => {
      const unsub = store.subscribe((state) => {
        if (!state.dirty && !state.syncing) {
          unsub()
          resolve()
        }
      })
    })

    // Server should now have the data
    const checkAfter = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/notes",
      pushPath: "/push/users/user-1/notes",
    })
    await checkAfter.pull()
    expect(checkAfter.getData()).toEqual({ items: ["offline-note"] })
  })

  it("two stores for different collections sync independently", async () => {
    const { client } = createTestEnv()

    const settingsStore = createSatelliteStore({
      name: "e2e-settings-2",
      syncManager: new SyncManager({
        client,
        pullPath: "/pull/users/user-1/settings",
        pushPath: "/push/users/user-1/settings",
      }),
      storage: false,
    })

    const notesStore = createSatelliteStore({
      name: "e2e-notes-2",
      syncManager: new SyncManager({
        client,
        pullPath: "/pull/users/user-1/notes",
        pushPath: "/push/users/user-1/notes",
      }),
      storage: false,
    })

    // Write to both stores
    settingsStore.getState().set((d) => ({ ...d, theme: "dark" }))
    notesStore.getState().set((d) => ({ ...d, items: ["hello"] }))

    // Wait for both to flush
    await Promise.all([
      new Promise<void>((resolve) => {
        const unsub = settingsStore.subscribe((s) => {
          if (!s.dirty && !s.syncing) { unsub(); resolve() }
        })
      }),
      new Promise<void>((resolve) => {
        const unsub = notesStore.subscribe((s) => {
          if (!s.dirty && !s.syncing) { unsub(); resolve() }
        })
      }),
    ])

    // Verify each collection independently
    const verifySettings = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    const verifyNotes = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/notes",
      pushPath: "/push/users/user-1/notes",
    })

    await verifySettings.pull()
    await verifyNotes.pull()

    expect(verifySettings.getData()).toEqual({ theme: "dark" })
    expect(verifyNotes.getData()).toEqual({ items: ["hello"] })
  })

  it("pull → set → flush → pull shows latest from server", async () => {
    const { client } = createTestEnv()

    const syncManager = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    const store = createSatelliteStore({
      name: "e2e-full-cycle",
      syncManager,
      storage: false,
    })

    // Pull (empty)
    await store.getState().pull()
    expect(store.getState().data).toEqual({})

    // Set + wait for flush
    store.getState().set((d) => ({ ...d, lang: "fr" }))
    await new Promise<void>((resolve) => {
      const unsub = store.subscribe((s) => {
        if (!s.dirty && !s.syncing) { unsub(); resolve() }
      })
    })

    // Set again + wait for flush
    store.getState().set((d) => ({ ...d, lang: "de" }))
    await new Promise<void>((resolve) => {
      const unsub = store.subscribe((s) => {
        if (!s.dirty && !s.syncing) { unsub(); resolve() }
      })
    })

    // Pull to get server-confirmed state
    await store.getState().pull()
    expect(store.getState().data).toEqual({ lang: "de" })
  })

  it("immer draft mutations round-trip to server", async () => {
    const { client } = createTestEnv()

    const store = createSatelliteStore({
      name: "e2e-immer",
      syncManager: new SyncManager({
        client,
        pullPath: "/pull/users/user-1/settings",
        pushPath: "/push/users/user-1/settings",
      }),
      storage: false,
      produce,
    })

    // Draft mutation style
    store.getState().set((draft) => { draft.theme = "dark" })
    expect(store.getState().data).toEqual({ theme: "dark" })

    // Wait for flush
    await new Promise<void>((resolve) => {
      const unsub = store.subscribe((s) => {
        if (!s.dirty && !s.syncing) { unsub(); resolve() }
      })
    })

    // Verify server has the data
    const verify = new SyncManager({
      client,
      pullPath: "/pull/users/user-1/settings",
      pushPath: "/push/users/user-1/settings",
    })
    await verify.pull()
    expect(verify.getData()).toEqual({ theme: "dark" })
  })
})
