import type { IObjectStore } from "../interfaces.js"
import { nextTimestamp } from "../timestamp.js"
import type { StoredDocument, PushResult } from "./types.js"
import { computeHash } from "./hash.js"
import { computeTimestamps } from "./timestamps.js"

const DOCUMENT_VERSION = 1

/**
 * Push a new full document.
 * - Compares baseHash with current document hash
 * - Match -> accept, compute timestamp diffs, store
 * - Mismatch -> reject with hash_mismatch
 * - baseHash: null for first push (no existing document expected)
 *
 * @param store - Storage backend
 * @param documentKey - Unique key identifying this document in the store
 * @param newData - The full document data to store
 * @param baseHash - Hash of the document the client last saw (null for first push)
 * @param author - Optional author identity for provenance tracking
 */
export async function push(
  store: IObjectStore,
  documentKey: string,
  newData: Record<string, unknown>,
  baseHash: string | null,
  author?: { pubkey: string; signature: string },
): Promise<PushResult> {
  const raw = await store.getString(documentKey)

  let oldData: Record<string, unknown> | null = null
  let oldTimestamps = null
  let currentHash = ""

  if (raw) {
    const existing = JSON.parse(raw) as StoredDocument
    oldData = existing.data
    oldTimestamps = existing.timestamps
    currentHash = existing.hash
  }

  // Hash check
  if (baseHash === null) {
    // First push: document must not exist
    if (raw) {
      return { ok: false, error: "hash_mismatch" }
    }
  } else {
    if (baseHash !== currentHash) {
      return { ok: false, error: "hash_mismatch" }
    }
  }

  const now = nextTimestamp()
  const newHash = await computeHash(newData)
  const timestamps = computeTimestamps(oldData, newData, oldTimestamps, now)

  const doc: StoredDocument = {
    v: DOCUMENT_VERSION,
    data: newData,
    timestamps,
    hash: newHash,
    ...(author && { authorPubkey: author.pubkey, authorSignature: author.signature }),
  }

  await store.put(documentKey, JSON.stringify(doc), { contentType: "application/json" })

  return { ok: true, hash: newHash, timestamp: now }
}
