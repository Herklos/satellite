import type { PullResponse, ConflictResolver } from "./types.js"
import { ConflictError } from "./types.js"
import { SatelliteClient } from "./client.js"
import type { Encryptor } from "./crypto.js"
import { createEncryptor } from "./crypto.js"

/** Default deep-merge: remote wins on conflicts. */
function defaultMerge(
  local: Record<string, unknown>,
  remote: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...local }
  for (const key of Object.keys(remote)) {
    const remoteVal = remote[key]
    const localVal = merged[key]
    if (
      remoteVal !== null &&
      typeof remoteVal === "object" &&
      !Array.isArray(remoteVal) &&
      localVal !== null &&
      typeof localVal === "object" &&
      !Array.isArray(localVal)
    ) {
      merged[key] = defaultMerge(
        localVal as Record<string, unknown>,
        remoteVal as Record<string, unknown>
      )
    } else {
      merged[key] = remoteVal
    }
  }
  return merged
}

/** Deep assign source into target (mutates target). */
function deepAssign(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const srcVal = source[key]
    const tgtVal = target[key]
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      target[key] = deepAssign(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      )
    } else {
      target[key] = srcVal
    }
  }
  return target
}

export interface SyncManagerOptions {
  /** The SatelliteClient instance. */
  client: SatelliteClient
  /** Pull endpoint path (e.g. "/pull/users/abc/settings"). */
  pullPath: string
  /** Push endpoint path (e.g. "/push/users/abc/settings"). */
  pushPath: string
  /** Custom conflict resolver (defaults to remote-wins deep merge). */
  onConflict?: ConflictResolver
  /** Max retry attempts on conflict (default: 3). */
  maxRetries?: number
  /** Secret for client-side AES-256-GCM encryption. When set, all data is encrypted before push and decrypted after pull. */
  encryptionSecret?: string
  /** Salt for encryption key derivation (typically the user's identity). Required when encryptionSecret is set. */
  encryptionSalt?: string
  /** HKDF info string for encryption domain separation (default: "satellite-e2e"). */
  encryptionInfo?: string
  /** Optional callback to sign data for author provenance. Receives stableStringify(data), returns signature string. */
  signData?: (data: string) => Promise<string>
}

/**
 * High-level sync manager that handles pull, push, and automatic conflict resolution.
 *
 * Tracks the last known hash and checkpoint locally to support incremental sync
 * and optimistic concurrency via hash-based conflict detection.
 */
export class SyncManager {
  private readonly client: SatelliteClient
  private readonly pullPath: string
  private readonly pushPath: string
  private readonly onConflict: ConflictResolver
  private readonly maxRetries: number
  private readonly encryptor: Encryptor | null
  private readonly signData?: (data: string) => Promise<string>

  private lastHash: string | null = null
  private lastCheckpoint: number = 0
  private localData: Record<string, unknown> = {}

  constructor(options: SyncManagerOptions) {
    this.client = options.client
    this.pullPath = options.pullPath
    this.pushPath = options.pushPath
    this.onConflict = options.onConflict ?? defaultMerge
    this.maxRetries = options.maxRetries ?? 3
    this.signData = options.signData
    this.encryptor =
      options.encryptionSecret && options.encryptionSalt
        ? createEncryptor(options.encryptionSecret, options.encryptionSalt, options.encryptionInfo)
        : null
  }

  /** Get the current local data snapshot. */
  getData(): Record<string, unknown> {
    return { ...this.localData }
  }

  /** Get the last known remote hash. */
  getHash(): string | null {
    return this.lastHash
  }

  /** Get the last checkpoint timestamp. */
  getCheckpoint(): number {
    return this.lastCheckpoint
  }

  /**
   * Pull latest data from the server.
   * Uses checkpoint for incremental sync if we've pulled before.
   */
  async pull(): Promise<PullResponse> {
    const result = await this.client.pull(this.pullPath, this.lastCheckpoint)

    if (this.encryptor) {
      const decrypted = await this.encryptor.decrypt(result.data)
      this.localData = decrypted
      result.data = decrypted
    } else if (this.lastCheckpoint > 0) {
      this.localData = deepAssign(this.localData, result.data)
    } else {
      this.localData = result.data
    }

    this.lastHash = result.hash
    this.lastCheckpoint = result.timestamp
    return result
  }

  /**
   * Push data to the server with automatic conflict resolution.
   *
   * On conflict (409):
   * 1. Re-pulls remote data
   * 2. Calls the conflict resolver with local and remote data
   * 3. Re-pushes the merged result
   * 4. Retries up to maxRetries times
   */
  async push(data: Record<string, unknown>): Promise<{ hash: string; timestamp: number }> {
    let attempt = 0
    let pendingData = data

    while (attempt <= this.maxRetries) {
      try {
        const payload = this.encryptor
          ? await this.encryptor.encrypt(pendingData)
          : pendingData

        const { stableStringify } = await import("./hash.js")
        const sig = this.signData
          ? await this.signData(stableStringify(pendingData))
          : undefined

        const result = await this.client.push(
          this.pushPath,
          payload,
          this.lastHash,
          sig
        )
        this.lastHash = result.hash
        this.lastCheckpoint = result.timestamp
        this.localData = pendingData
        return result
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt >= this.maxRetries) {
          throw err
        }
        const remote = await this.client.pull(this.pullPath)
        this.lastHash = remote.hash
        this.lastCheckpoint = remote.timestamp

        const remoteData = this.encryptor
          ? await this.encryptor.decrypt(remote.data)
          : remote.data
        pendingData = this.onConflict(pendingData, remoteData)
        attempt++
      }
    }
    throw new ConflictError()
  }

  /**
   * Convenience: pull-modify-push cycle.
   * Pulls latest, applies modifier function, pushes result.
   */
  async update(
    modifier: (current: Record<string, unknown>) => Record<string, unknown>
  ): Promise<{ hash: string; timestamp: number }> {
    await this.pull()
    const updated = modifier(this.localData)
    return this.push(updated)
  }
}
