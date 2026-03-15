import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { MemoryObjectStore } from "../helpers/memory-store.js"
import { ReplicaManager } from "../../src/replica/manager.js"
import { push } from "../../src/protocol/index.js"
import type { WildcardRemoteConfig } from "../../src/config/schema.js"

// ── Helpers ───────────────────────────────────────────────────────────────

function makeWildcard(overrides: Partial<WildcardRemoteConfig> = {}): WildcardRemoteConfig {
  return {
    url: "https://primary.example.com/v1",
    pullPathTemplate: "/pull/{name}",
    readRoles: ["public"],
    headers: {},
    negativeCacheMs: 300_000,
    maxBodyBytes: 65536,
    ...overrides,
  }
}

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

function primaryResponse(data: Record<string, unknown>, hash = "h1") {
  return { data, hash, timestamp: 1000 }
}

function makeManager(store: MemoryObjectStore, wildcard?: Partial<WildcardRemoteConfig>) {
  return new ReplicaManager(store, { wildcardRemote: makeWildcard(wildcard) })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ReplicaManager.onPullWildcard", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ── Basic fetch ──────────────────────────────────────────────────────────

  it("fetches from primary and stores locally on 200", async () => {
    const store = new MemoryObjectStore()
    vi.stubGlobal("fetch", makeFetch(200, primaryResponse({ title: "Trending" }, "h1")))

    const manager = makeManager(store)
    const found = await manager.onPullWildcard("posts/trending")

    expect(found).toBe(true)
    const raw = await store.getString("posts/trending")
    expect(JSON.parse(raw!).data).toEqual({ title: "Trending" })
  })

  it("substitutes {name} correctly in pullPathTemplate", async () => {
    const store = new MemoryObjectStore()
    const fetchMock = makeFetch(200, primaryResponse({ x: 1 }, "h2"))
    vi.stubGlobal("fetch", fetchMock)

    const manager = makeManager(store)
    await manager.onPullWildcard("a/b/c")

    expect(fetchMock).toHaveBeenCalledWith(
      "https://primary.example.com/v1/pull/a/b/c",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }),
    )
  })

  it("returns false when primary returns empty hash", async () => {
    const store = new MemoryObjectStore()
    vi.stubGlobal("fetch", makeFetch(200, { data: {}, hash: "", timestamp: 0 }))

    const manager = makeManager(store)
    const found = await manager.onPullWildcard("empty/col")

    expect(found).toBe(false)
    expect(await store.getString("empty/col")).toBeNull()
  })

  it("returns false when no wildcardRemote configured", async () => {
    const store = new MemoryObjectStore()
    const manager = new ReplicaManager(store)
    expect(await manager.onPullWildcard("any/path")).toBe(false)
  })

  // ── Negative caching ─────────────────────────────────────────────────────

  it.each([404, 403, 401])("negative-caches HTTP %i — primary contacted only once", async (status) => {
    const store = new MemoryObjectStore()
    const fetchMock = makeFetch(status, {})
    vi.stubGlobal("fetch", fetchMock)

    const manager = makeManager(store)
    const first = await manager.onPullWildcard("secret/col")
    const second = await manager.onPullWildcard("secret/col")  // hits negative cache

    expect(first).toBe(false)
    expect(second).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("serves stale local data when negatively cached but local copy exists", async () => {
    const store = new MemoryObjectStore()
    await push(store, "archive/old", { content: "stale" }, null)
    vi.stubGlobal("fetch", makeFetch(403, {}))

    const manager = makeManager(store)
    const found = await manager.onPullWildcard("archive/old")

    expect(found).toBe(true)
    const raw = await store.getString("archive/old")
    expect(JSON.parse(raw!).data).toEqual({ content: "stale" })
  })

  it("retries after negative cache expires", async () => {
    const store = new MemoryObjectStore()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => primaryResponse({ v: 2 }, "h4"),
      })
    vi.stubGlobal("fetch", fetchMock)

    const manager = makeManager(store, { negativeCacheMs: 1 })
    await manager.onPullWildcard("posts/new")  // 404 → negative-cached

    // Force expire by backdating the cache entry
    ;(manager as unknown as { negativeCache: Map<string, number> })
      .negativeCache.set("posts/new", Date.now() - 10)

    const found = await manager.onPullWildcard("posts/new")  // expired → retry

    expect(found).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse((await store.getString("posts/new"))!).data).toEqual({ v: 2 })
  })

  // ── Stale-on-error ───────────────────────────────────────────────────────

  it("serves stale data on primary 5xx", async () => {
    const store = new MemoryObjectStore()
    await push(store, "feed/main", { items: [1, 2, 3] }, null)
    vi.stubGlobal("fetch", makeFetch(503, {}))

    const manager = makeManager(store)
    expect(await manager.onPullWildcard("feed/main")).toBe(true)
  })

  it("returns false on 5xx when no local data exists", async () => {
    const store = new MemoryObjectStore()
    vi.stubGlobal("fetch", makeFetch(503, {}))

    const manager = makeManager(store)
    expect(await manager.onPullWildcard("missing/col")).toBe(false)
  })

  it("serves stale data on network error", async () => {
    const store = new MemoryObjectStore()
    await push(store, "cached/doc", { z: 99 }, null)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unreachable")))

    const manager = makeManager(store)
    expect(await manager.onPullWildcard("cached/doc")).toBe(true)
  })

  // ── onPullMinIntervalMs cooldown ─────────────────────────────────────────

  it("respects onPullMinIntervalMs cooldown — primary hit only once", async () => {
    const store = new MemoryObjectStore()
    const fetchMock = makeFetch(200, primaryResponse({ a: 1 }, "h5"))
    vi.stubGlobal("fetch", fetchMock)

    const manager = makeManager(store, { onPullMinIntervalMs: 5_000 })
    await manager.onPullWildcard("cool/col")   // fetches from primary
    await manager.onPullWildcard("cool/col")   // within cooldown — skips fetch

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("fetches again after cooldown expires", async () => {
    const store = new MemoryObjectStore()
    const fetchMock = makeFetch(200, primaryResponse({ a: 1 }, "h6"))
    vi.stubGlobal("fetch", fetchMock)

    const manager = makeManager(store, { onPullMinIntervalMs: 1 })
    await manager.onPullWildcard("cool/col")

    // Backdate last sync to force cooldown expiry
    ;(manager as unknown as { wildcardLastSyncAt: Map<string, number> })
      .wildcardLastSyncAt.set("cool/col", Date.now() - 100)

    await manager.onPullWildcard("cool/col")

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // ── Hash deduplication ───────────────────────────────────────────────────

  it("skips write when wildcardLastHash matches primary hash", async () => {
    const store = new MemoryObjectStore()
    const fetchMock = makeFetch(200, primaryResponse({ v: 1 }, "same-hash"))
    vi.stubGlobal("fetch", fetchMock)

    const manager = makeManager(store)
    await manager.onPullWildcard("dedup/col")
    const raw1 = await store.getString("dedup/col")

    // Pre-set hash to simulate already knowing this version
    ;(manager as unknown as { wildcardLastHash: Map<string, string> })
      .wildcardLastHash.set("dedup/col", "same-hash")

    await manager.onPullWildcard("dedup/col")
    const raw2 = await store.getString("dedup/col")

    expect(raw2).toBe(raw1)  // unchanged — write was skipped
  })
})
