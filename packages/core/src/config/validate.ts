import type { SyncConfig } from "./schema.js"

/**
 * Semantic validation beyond what Zod covers.
 * Returns an array of error messages (empty = valid).
 */
export function validateConfig(config: SyncConfig): string[] {
  const errors: string[] = []
  const names = new Set<string>()

  for (const col of config.collections) {
    // Duplicate names
    if (names.has(col.name)) {
      errors.push(`Duplicate collection name: "${col.name}"`)
    }
    names.add(col.name)

    // storagePath must contain at least one segment
    if (col.storagePath.startsWith("/")) {
      errors.push(`Collection "${col.name}": storagePath must not start with /`)
    }

    // pullOnly + pushOnly conflict
    if (col.pullOnly && col.pushOnly) {
      errors.push(`Collection "${col.name}": cannot be both pullOnly and pushOnly`)
    }

    // Bundled collections must use identity encryption
    if (col.bundle && col.encryption !== "identity") {
      errors.push(`Collection "${col.name}": bundled collections must use "identity" encryption`)
    }

    // Bundled collections must have {identity} in storagePath
    if (col.bundle && !col.storagePath.includes("{identity}")) {
      errors.push(`Collection "${col.name}": bundled collections must have {identity} in storagePath`)
    }

    // readRoles or writeRoles should not be empty (unless pullOnly/pushOnly)
    if (!col.pullOnly && col.readRoles.length === 0) {
      errors.push(`Collection "${col.name}": readRoles must not be empty (use ["public"] for public access)`)
    }
    if (!col.pushOnly && col.writeRoles.length === 0 && !col.pullOnly) {
      // writeRoles can be empty for pullOnly collections
    }
  }

  // Check bundles: all collections in the same bundle must share the same storagePath
  const bundles = new Map<string, string>()
  for (const col of config.collections) {
    if (!col.bundle) continue
    const existing = bundles.get(col.bundle)
    if (existing && existing !== col.storagePath) {
      errors.push(`Bundle "${col.bundle}": all collections must share the same storagePath (found "${existing}" and "${col.storagePath}")`)
    }
    bundles.set(col.bundle, col.storagePath)
  }

  return errors
}
