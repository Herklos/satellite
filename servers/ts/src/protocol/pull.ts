import type { IObjectStore } from "../interfaces.js"
import { nextTimestamp } from "../timestamp.js"
import type { StoredDocument, PullResult } from "./types.js"
import { filterByCheckpoint } from "./timestamps.js"

/**
 * Pull the current document, optionally filtered by checkpoint.
 * - No checkpoint (or 0): returns full data
 * - With checkpoint: returns only paths updated after checkpoint
 * - hash is always the hash of the FULL document
 *
 * @param store - Storage backend
 * @param documentKey - Unique key identifying this document in the store
 * @param checkpoint - Only return data updated after this timestamp
 */
export async function pull(
  store: IObjectStore,
  documentKey: string,
  checkpoint?: number,
): Promise<PullResult> {
  const timestamp = nextTimestamp()
  const raw = await store.getString(documentKey)

  if (!raw) {
    return { data: {}, hash: "", timestamp }
  }

  const doc = JSON.parse(raw) as StoredDocument

  if (checkpoint && checkpoint > 0 && Object.keys(doc.timestamps).length > 0) {
    const filtered = filterByCheckpoint(doc.data, doc.timestamps, checkpoint)
    return { data: filtered, hash: doc.hash, timestamp, authorPubkey: doc.authorPubkey, authorSignature: doc.authorSignature }
  }

  return { data: doc.data, hash: doc.hash, timestamp, authorPubkey: doc.authorPubkey, authorSignature: doc.authorSignature }
}
