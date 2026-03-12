import { describe, it, expect } from "vitest"
import { MemoryObjectStore } from "../helpers/memory-store.js"
import { createSyncRouter } from "../../src/router/route-builder.js"
import type { AuthResult, SyncRouterOptions } from "../../src/router/route-builder.js"
import type { SyncConfig } from "../../src/config/schema.js"

const config: SyncConfig = {
  version: 1,
  collections: [
    {
      name: "signals",
      storagePath: "products/{productId}/signals",
      readRoles: ["public"],
      writeRoles: ["admin"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
    {
      name: "settings",
      storagePath: "users/{identity}/settings",
      readRoles: ["self"],
      writeRoles: ["self"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
  ],
}

function makeRouter(overrides: Partial<SyncRouterOptions> = {}) {
  const store = new MemoryObjectStore()
  const opts: SyncRouterOptions = {
    store,
    config,
    roleResolver: async () => ({ identity: "user-1", roles: ["admin"] }),
    ...overrides,
  }
  return { router: createSyncRouter(opts), store }
}

function jsonReq(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("createSyncRouter", () => {
  it("pull returns empty data for non-existent document", async () => {
    const { router } = makeRouter()
    const res = await router.request("/pull/products/abc/signals")
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toEqual({})
    expect(json.hash).toBe("")
  })

  it("push then pull round-trips data", async () => {
    const { router } = makeRouter()

    const pushRes = await router.fetch(
      jsonReq("/push/products/abc/signals", { data: { key1: "value1" }, baseHash: null })
    )
    expect(pushRes.status).toBe(200)
    const pushJson = await pushRes.json() as { hash: string; timestamp: number }
    expect(pushJson.hash).toMatch(/^[0-9a-f]{64}$/)

    const pullRes = await router.request("/pull/products/abc/signals")
    expect(pullRes.status).toBe(200)
    const pullJson = await pullRes.json() as { data: Record<string, unknown>; hash: string }
    expect(pullJson.data).toEqual({ key1: "value1" })
    expect(pullJson.hash).toBe(pushJson.hash)
  })

  it("push with wrong baseHash returns 409", async () => {
    const { router } = makeRouter()

    // First push
    await router.fetch(jsonReq("/push/products/abc/signals", { data: { a: 1 }, baseHash: null }))

    // Second push with wrong hash
    const res = await router.fetch(
      jsonReq("/push/products/abc/signals", { data: { a: 2 }, baseHash: "wrong" })
    )
    expect(res.status).toBe(409)
  })

  it("public read requires no auth", async () => {
    const { router } = makeRouter({
      roleResolver: async () => { throw new Error("should not be called") },
    })

    const res = await router.request("/pull/products/abc/signals")
    expect(res.status).toBe(200)
  })

  it("protected write returns 401 when auth fails", async () => {
    const { router } = makeRouter({
      roleResolver: async () => { throw new Error("auth failed") },
    })

    const res = await router.fetch(
      jsonReq("/push/products/abc/signals", { data: { a: 1 }, baseHash: null })
    )
    expect(res.status).toBe(401)
  })

  it("self role is auto-granted when identity matches", async () => {
    const { router } = makeRouter({
      roleResolver: async () => ({ identity: "user-1", roles: [] }),
    })

    // user-1 accesses their own settings — "self" should be auto-granted
    const res = await router.request("/pull/users/user-1/settings")
    expect(res.status).toBe(200)
  })

  it("self role is denied when identity does not match", async () => {
    const { router } = makeRouter({
      roleResolver: async () => ({ identity: "user-1", roles: [] }),
    })

    // user-1 tries to access user-2's settings
    const res = await router.request("/pull/users/user-2/settings")
    expect(res.status).toBe(403)
  })
})
