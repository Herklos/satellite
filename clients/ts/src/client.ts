import type {
  PullResponse,
  PushSuccess,
  SatelliteClientOptions,
  AuthProvider,
} from "./types.js"
import { ConflictError, SatelliteHttpError } from "./types.js"

/**
 * Low-level HTTP client for the Satellite sync protocol.
 * Handles auth headers and response parsing.
 */
export class SatelliteClient {
  private readonly baseUrl: string
  private readonly auth?: AuthProvider
  private readonly fetch: typeof globalThis.fetch

  constructor(options: SatelliteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "")
    this.auth = options.auth
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * Pull synced data from the server.
   * @param path - The pull endpoint path (e.g. "/pull/users/abc/settings")
   * @param checkpoint - Only return data updated after this timestamp (0 = full pull)
   */
  async pull(path: string, checkpoint?: number): Promise<PullResponse> {
    const url = checkpoint
      ? `${this.baseUrl}${path}?checkpoint=${checkpoint}`
      : `${this.baseUrl}${path}`

    const authHeaders = this.auth
      ? await this.auth({ method: "GET", path, body: null })
      : {}

    const res = await this.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeaders },
    })
    if (!res.ok) {
      throw new SatelliteHttpError(res.status, await res.text())
    }
    return res.json() as Promise<PullResponse>
  }

  /**
   * Push synced data to the server.
   * @param path - The push endpoint path (e.g. "/push/users/abc/settings")
   * @param data - The full document data to push
   * @param baseHash - Hash of the document this push is based on (null for first push)
   * @param authorSignature - Optional author signature for provenance
   * @throws {ConflictError} if the server detects a hash mismatch (409)
   */
  async push(
    path: string,
    data: Record<string, unknown>,
    baseHash: string | null,
    authorSignature?: string
  ): Promise<PushSuccess> {
    const body = JSON.stringify({
      data,
      baseHash,
      ...(authorSignature && { authorSignature }),
    })

    const authHeaders = this.auth
      ? await this.auth({ method: "POST", path, body })
      : {}

    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...authHeaders,
      },
      body,
    })

    if (res.status === 409) {
      throw new ConflictError()
    }
    if (!res.ok) {
      throw new SatelliteHttpError(res.status, await res.text())
    }
    return res.json() as Promise<PushSuccess>
  }
}
