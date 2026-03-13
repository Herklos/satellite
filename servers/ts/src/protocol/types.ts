export type Timestamps = { [key: string]: number | Timestamps }

export interface StoredDocument {
  v: number
  data: Record<string, unknown>
  timestamps: Timestamps
  hash: string
  authorPubkey?: string
  authorSignature?: string
}

export interface PullResult {
  data: Record<string, unknown>
  hash: string
  timestamp: number
  authorPubkey?: string
  authorSignature?: string
}

export type PushResult =
  | { ok: true; hash: string; timestamp: number }
  | { ok: false; error: "hash_mismatch" }
