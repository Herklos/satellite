import { push } from "../protocol/index.js"
import type { IObjectStore } from "../interfaces.js"
import type { WildcardRemoteConfig } from "../config/schema.js"

/**
 * Manages replica-side synchronisation from a primary satellite server.
 *
 * Currently implements **wildcard on-demand pull**: any collection path not
 * matched by an explicit ``CollectionConfig`` can be fetched from the primary
 * on demand via {@link onPullWildcard}, cached locally, and served by the
 * wildcard catch-all pull route.
 *
 * Example:
 * ```ts
 * const manager = new ReplicaManager(store, {
 *   wildcardRemote: {
 *     url: "https://primary.example.com/v1",
 *     pullPathTemplate: "/pull/{name}",
 *     readRoles: ["public"],
 *   },
 * })
 * ```
 */
export class ReplicaManager {
  private readonly negativeCache = new Map<string, number>()     // path → Date.now()
  private readonly wildcardLastSyncAt = new Map<string, number>() // path → Date.now()
  private readonly wildcardLastHash = new Map<string, string>()   // path → hash

  constructor(
    private readonly store: IObjectStore,
    private readonly options: { wildcardRemote?: WildcardRemoteConfig } = {},
  ) {}

  /**
   * Called by the wildcard catch-all pull route for paths not matched by any
   * explicit collection.
   *
   * Fetches from the primary on demand, stores the result locally, and returns
   * `true` if data is available (freshly fetched or stale cached).
   *
   * Returns `false` when the collection does not exist or is not authorised on
   * the primary **and** no stale copy is held locally.
   *
   * Negative results (404 / 403 / 401) are cached for
   * `wildcardRemote.negativeCacheMs` to avoid hammering the primary. Stale
   * local data is still served during this window. On primary unavailability
   * (network errors, 5xx) stale local data is served when available.
   */
  async onPullWildcard(path: string): Promise<boolean> {
    const wc = this.options.wildcardRemote
    if (!wc) return false

    const now = Date.now()

    // ── Negative cache ────────────────────────────────────────────────────
    const negTs = this.negativeCache.get(path)
    if (negTs !== undefined) {
      if (now - negTs < wc.negativeCacheMs) {
        return (await this.store.getString(path)) !== null
      }
      // Cache expired — remove and retry
      this.negativeCache.delete(path)
    }

    // ── on-pull cooldown ──────────────────────────────────────────────────
    if (wc.onPullMinIntervalMs !== undefined) {
      const last = this.wildcardLastSyncAt.get(path)
      if (last !== undefined && now - last < wc.onPullMinIntervalMs) {
        const local = await this.store.getString(path)
        if (local !== null) return true
        // No local data despite being within cooldown — fall through to fetch
      }
    }

    // ── Fetch from primary ────────────────────────────────────────────────
    const pullPath = wc.pullPathTemplate.replace("{name}", path)
    const primaryUrl = `${wc.url.replace(/\/$/, "")}${pullPath}`

    let resp: Response
    try {
      resp = await fetch(primaryUrl, {
        headers: { Accept: "application/json", ...wc.headers },
      })
    } catch (err) {
      console.warn(`[ReplicaManager] Wildcard fetch failed for "${path}":`, err)
      return (await this.store.getString(path)) !== null
    }

    if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
      this.negativeCache.set(path, now)
      console.debug(
        `[ReplicaManager] Wildcard "${path}": primary returned HTTP ${resp.status} — negative-cached`,
      )
      return (await this.store.getString(path)) !== null
    }

    if (!resp.ok) {
      console.warn(
        `[ReplicaManager] Wildcard fetch for "${path}" returned HTTP ${resp.status} — serving stale`,
      )
      return (await this.store.getString(path)) !== null
    }

    const pulled = (await resp.json()) as { data?: Record<string, unknown>; hash?: string }
    const primaryHash = pulled.hash ?? ""
    const primaryData = pulled.data ?? {}

    if (!primaryHash) {
      // Empty collection on primary
      return false
    }

    // Skip write if we already have this version
    if (this.wildcardLastHash.get(path) !== primaryHash) {
      const rawLocal = await this.store.getString(path)
      let currentHash: string | null = null
      if (rawLocal !== null) {
        currentHash = (JSON.parse(rawLocal) as { hash?: string }).hash ?? null
      }

      if (currentHash !== primaryHash) {
        const result = await push(this.store, path, primaryData, currentHash)
        if (result.ok) {
          this.wildcardLastHash.set(path, result.hash)
        }
      } else {
        this.wildcardLastHash.set(path, primaryHash)
      }
    }

    this.wildcardLastSyncAt.set(path, now)
    console.debug(`[ReplicaManager] Wildcard synced "${path}" (hash=${primaryHash})`)
    return true
  }
}
