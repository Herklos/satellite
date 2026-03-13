import { describe, it, expect } from "vitest"
import { MemoryObjectStore } from "../helpers/memory-store.js"
import { SyncConfigSchema, validateConfig, loadConfig, saveConfig } from "../../src/config/index.js"
import type { SyncConfig } from "../../src/config/index.js"

const validConfig: SyncConfig = {
  version: 1,
  collections: [
    {
      name: "signals",
      storagePath: "products/{productId}/signals",
      readRoles: ["public"],
      writeRoles: ["owner"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
    {
      name: "settings",
      storagePath: "users/{identity}/settings",
      readRoles: ["self", "admin"],
      writeRoles: ["self"],
      encryption: "identity",
      maxBodyBytes: 131072,
    },
  ],
}

describe("SyncConfigSchema", () => {
  it("parses a valid config", () => {
    const result = SyncConfigSchema.parse(validConfig)
    expect(result.version).toBe(1)
    expect(result.collections).toHaveLength(2)
  })

  it("rejects invalid version", () => {
    expect(() => SyncConfigSchema.parse({ ...validConfig, version: 2 })).toThrow()
  })

  it("rejects empty collection name", () => {
    const bad = {
      ...validConfig,
      collections: [{ ...validConfig.collections[0], name: "" }],
    }
    expect(() => SyncConfigSchema.parse(bad)).toThrow()
  })
})

describe("validateConfig", () => {
  it("returns no errors for valid config", () => {
    expect(validateConfig(validConfig)).toEqual([])
  })

  it("detects duplicate collection names", () => {
    const dupe: SyncConfig = {
      version: 1,
      collections: [
        { name: "a", storagePath: "x", readRoles: ["public"], writeRoles: ["admin"], encryption: "none", maxBodyBytes: 1024 },
        { name: "a", storagePath: "y", readRoles: ["public"], writeRoles: ["admin"], encryption: "none", maxBodyBytes: 1024 },
      ],
    }
    const errors = validateConfig(dupe)
    expect(errors).toContainEqual(expect.stringContaining("Duplicate"))
  })

  it("detects pullOnly + pushOnly conflict", () => {
    const bad: SyncConfig = {
      version: 1,
      collections: [
        { name: "a", storagePath: "x", readRoles: ["public"], writeRoles: ["admin"], encryption: "none", maxBodyBytes: 1024, pullOnly: true, pushOnly: true },
      ],
    }
    const errors = validateConfig(bad)
    expect(errors).toContainEqual(expect.stringContaining("pullOnly"))
  })
})

describe("loadConfig / saveConfig", () => {
  it("round-trips config through storage", async () => {
    const store = new MemoryObjectStore()
    await saveConfig(store, validConfig)

    const loaded = await loadConfig(store)
    expect(loaded).toEqual(validConfig)
  })

  it("returns null when no config exists", async () => {
    const store = new MemoryObjectStore()
    const loaded = await loadConfig(store)
    expect(loaded).toBeNull()
  })
})
