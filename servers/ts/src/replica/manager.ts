import type { IObjectStore } from "../interfaces.js"
import type { CollectionConfig } from "../config/schema.js"
import { push } from "../protocol/push.js"

export interface ReplicaManagerOptions {
  /** Storage backend shared with the satellite server. */
  store: IObjectStore
  /** All collections from the sync config. Only those with a `remote` field are replicated. */
  collections: CollectionConfig[]
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch
  /** Called when a sync cycle fails. Defaults to console.error. */
  onError?: (collectionName: string, error: unknown) => void
}

interface CollectionState {
  /** Last known hash from the primary — used to skip writes when nothing changed. */
  lastHash: string
}

/**
 * Manages scheduled replication from a remote (primary) satellite server.
 *
 * For each collection that has a `remote` field in its config, the ReplicaManager
 * periodically fetches the document from the primary and writes it to local storage.
 * The local collection becomes effectively read-only: clients on this server can pull
 * the replicated data but the only writer is the ReplicaManager itself.
 *
 * Usage:
 * ```ts
 * const replica = new ReplicaManager({ store, collections: config.collections })
 * replica.start()            // begins background sync
 * // ...
 * replica.stop()             // stops all timers on shutdown
 * await replica.syncAll()    // one-shot sync of all remote collections
 * ```
 */
export class ReplicaManager {
  private readonly store: IObjectStore
  private readonly remoteCollections: CollectionConfig[]
  private readonly _fetch: typeof globalThis.fetch
  private readonly onError: (name: string, err: unknown) => void

  private readonly state = new Map<string, CollectionState>()
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(options: ReplicaManagerOptions) {
    this.store = options.store
    this.remoteCollections = options.collections.filter(c => c.remote != null)
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.onError = options.onError ?? ((name, err) => {
      console.error(`[ReplicaManager] "${name}":`, err)
    })
  }

  /**
   * Start background sync for all remote collections.
   * Each collection is synced immediately, then on its configured interval.
   * Calling start() multiple times is safe — already-running timers are skipped.
   */
  start(): void {
    for (const col of this.remoteCollections) {
      if (this.timers.has(col.name)) continue

      const intervalMs = col.remote!.intervalMs

      // Sync immediately, then on the configured schedule
      void this._syncCollection(col)

      const timer = setInterval(() => {
        void this._syncCollection(col)
      }, intervalMs)

      this.timers.set(col.name, timer)
    }
  }

  /**
   * Stop all background sync timers.
   * Any in-progress sync cycles will run to completion.
   */
  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
  }

  /**
   * Trigger an immediate sync for a single collection by name.
   * Works regardless of whether start() has been called.
   */
  async syncNow(name: string): Promise<void> {
    const col = this.remoteCollections.find(c => c.name === name)
    if (!col) throw new Error(`[ReplicaManager] Unknown remote collection: "${name}"`)
    await this._syncCollection(col)
  }

  /**
   * Trigger an immediate sync for all remote collections in parallel.
   * Works regardless of whether start() has been called.
   */
  async syncAll(): Promise<void> {
    await Promise.all(this.remoteCollections.map(col => this._syncCollection(col)))
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async _syncCollection(col: CollectionConfig): Promise<void> {
    try {
      await this._doSync(col)
    } catch (err) {
      this.onError(col.name, err)
    }
  }

  private async _doSync(col: CollectionConfig): Promise<void> {
    const remote = col.remote!
    const documentKey = col.storagePath // static path — no template variables (enforced by config validation)

    // Build the primary URL for a full pull (no checkpoint — always fetch complete document
    // so we can write a self-contained replica copy without needing local merge logic)
    const primaryUrl = `${remote.url.replace(/\/$/, "")}${remote.pullPath}`

    const res = await this._fetch(primaryUrl, {
      method: "GET",
      headers: { Accept: "application/json", ...remote.headers },
    })

    if (!res.ok) {
      throw new Error(`Primary returned HTTP ${res.status}: ${await res.text()}`)
    }

    const pulled = await res.json() as {
      data: Record<string, unknown>
      hash: string
      timestamp: number
    }

    // Primary has no document yet — nothing to replicate
    if (!pulled.hash) return

    // Check local state: skip write if primary hasn't changed
    const localState = this.state.get(col.name)
    if (localState?.lastHash === pulled.hash) return

    // Read the current local document to get its hash for the optimistic write
    const rawLocal = await this.store.getString(documentKey)
    const currentLocalHash = rawLocal
      ? (JSON.parse(rawLocal) as { hash: string }).hash
      : ""

    // If the local document already matches the primary, just update state and return
    if (currentLocalHash === pulled.hash) {
      this.state.set(col.name, { lastHash: pulled.hash })
      return
    }

    // Write the primary's data to local storage.
    // baseHash = null → first write (doc doesn't exist locally yet)
    // baseHash = currentLocalHash → replace the existing local document
    const baseHash = currentLocalHash === "" ? null : currentLocalHash
    const result = await push(this.store, documentKey, pulled.data, baseHash)

    if (!result.ok) {
      // Concurrent write by someone else between our read and write — will self-correct next cycle
      throw new Error(`Concurrent write detected for "${col.name}" — will retry on next interval`)
    }

    this.state.set(col.name, { lastHash: result.hash })
  }
}
