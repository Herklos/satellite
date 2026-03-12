/** Response from a pull request. */
export interface PullResponse {
  data: Record<string, unknown>
  hash: string
  timestamp: number
  authorPubkey?: string
  authorSignature?: string
}

/** Response from a successful push. */
export interface PushSuccess {
  hash: string
  timestamp: number
}

/** Push conflict error (HTTP 409). */
export class ConflictError extends Error {
  constructor() {
    super("hash_mismatch")
    this.name = "ConflictError"
  }
}

/** HTTP error from the Satellite server. */
export class SatelliteHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`)
    this.name = "SatelliteHttpError"
  }
}

/**
 * Auth provider: returns headers to include in requests.
 * Called for every authenticated request (pull and push).
 */
export type AuthProvider = (req: {
  method: string
  path: string
  body: string | null
}) => Record<string, string> | Promise<Record<string, string>>

/** Options for creating a SatelliteClient. */
export interface SatelliteClientOptions {
  /** Base URL of the Satellite server (e.g. "https://api.example.com/v1"). */
  baseUrl: string
  /** Auth provider that returns headers for authenticated requests. Optional for public-read collections. */
  auth?: AuthProvider
  /** Optional fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch
}

/** Conflict resolver: given local and remote data, return merged result. */
export type ConflictResolver = (
  local: Record<string, unknown>,
  remote: Record<string, unknown>
) => Record<string, unknown>
