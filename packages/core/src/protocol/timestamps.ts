import type { Timestamps } from "./types.js"

/**
 * Returns true if the value is a "leaf" in our data model
 * (anything that is not a plain object — primitives, arrays, null).
 */
function isLeaf(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (Array.isArray(v)) return true
  return typeof v !== "object"
}

/**
 * Compute new timestamps by diffing old and new data trees.
 * - Unchanged leaf values keep their old timestamp
 * - Changed or new values get `now`
 * - Removed keys are omitted from the result
 */
export function computeTimestamps(
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown>,
  oldTimestamps: Timestamps | null,
  now: number
): Timestamps {
  const result: Timestamps = {}

  for (const key of Object.keys(newData)) {
    const newVal = newData[key]
    const oldVal = oldData?.[key]
    const oldTs = oldTimestamps?.[key]

    if (isLeaf(newVal)) {
      // Leaf: compare with old value
      if (oldData && key in oldData && isLeaf(oldVal) && stableEqual(oldVal, newVal) && typeof oldTs === "number") {
        result[key] = oldTs
      } else {
        result[key] = now
      }
    } else {
      // Object: recurse
      const newObj = newVal as Record<string, unknown>
      const oldObj = (!isLeaf(oldVal) && oldVal !== null && oldVal !== undefined)
        ? oldVal as Record<string, unknown>
        : null
      const oldTsObj = (oldTs !== null && oldTs !== undefined && typeof oldTs === "object")
        ? oldTs as Timestamps
        : null
      result[key] = computeTimestamps(oldObj, newObj, oldTsObj, now)
    }
  }

  return result
}

/**
 * Filter data to only include paths where the timestamp > checkpoint.
 * Maintains nesting structure.
 */
export function filterByCheckpoint(
  data: Record<string, unknown>,
  timestamps: Timestamps,
  checkpoint: number
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const key of Object.keys(data)) {
    const val = data[key]
    const ts = timestamps[key]

    if (ts === undefined) continue

    if (typeof ts === "number") {
      // Leaf timestamp
      if (ts > checkpoint) {
        result[key] = val
      }
    } else {
      // Nested object
      if (isLeaf(val)) {
        // Mismatch: timestamps say object but data is leaf — include if any sub-ts > checkpoint
        result[key] = val
      } else {
        const filtered = filterByCheckpoint(
          val as Record<string, unknown>,
          ts,
          checkpoint
        )
        if (Object.keys(filtered).length > 0) {
          result[key] = filtered
        }
      }
    }
  }

  return result
}

/**
 * Deep equality for leaf values (primitives, arrays, null).
 */
function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!stableEqual(a[i], b[i])) return false
    }
    return true
  }
  return false
}
