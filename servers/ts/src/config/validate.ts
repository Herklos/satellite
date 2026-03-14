import type { SyncConfig } from "./schema.js"
import { ENCRYPTION_IDENTITY, ENCRYPTION_DELEGATED, IDENTITY_PARAM, ROLE_PUBLIC } from "../constants.js"

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

    // Public collections must not use identity-based encryption
    if (col.readRoles.includes(ROLE_PUBLIC) && col.encryption === ENCRYPTION_IDENTITY) {
      errors.push(`Collection "${col.name}": public collections must not use "${ENCRYPTION_IDENTITY}" encryption (key would be derived from empty identity)`)
    }

    // Bundled collections must use identity encryption
    if (col.bundle && col.encryption !== ENCRYPTION_IDENTITY) {
      errors.push(`Collection "${col.name}": bundled collections must use "${ENCRYPTION_IDENTITY}" encryption`)
    }

    // Bundled collections must have {identity} in storagePath
    if (col.bundle && !col.storagePath.includes(IDENTITY_PARAM)) {
      errors.push(`Collection "${col.name}": bundled collections must have ${IDENTITY_PARAM} in storagePath`)
    }

    // readRoles or writeRoles should not be empty (unless pullOnly/pushOnly)
    if (!col.pullOnly && col.readRoles.length === 0) {
      errors.push(`Collection "${col.name}": readRoles must not be empty (use ["${ROLE_PUBLIC}"] for public access)`)
    }
    if (!col.pushOnly && col.writeRoles.length === 0 && !col.pullOnly) {
      // writeRoles can be empty for pullOnly collections
    }

    // Remote collection constraints
    if (col.remote) {
      // Remote collections are read-only on the replica — pushOnly makes no sense
      if (col.pushOnly) {
        errors.push(`Collection "${col.name}": remote collections cannot be pushOnly`)
      }
      // Template variables in storagePath require per-document resolution which replication doesn't support
      if (/\{[^}]+\}/.test(col.storagePath)) {
        errors.push(`Collection "${col.name}": remote collections must have a static storagePath with no template variables (found "${col.storagePath}")`)
      }
      // Bundled collections have a more complex pull path that conflicts with simple remote replication
      if (col.bundle) {
        errors.push(`Collection "${col.name}": remote collections cannot be part of a bundle`)
      }
      // Delegated (client-side) encryption cannot be replicated server-side
      if (col.encryption === ENCRYPTION_DELEGATED) {
        errors.push(`Collection "${col.name}": remote collections cannot use delegated encryption (server cannot replicate opaque client-encrypted blobs)`)
      }
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
