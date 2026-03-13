import type { Context } from "hono"
import type { IObjectStore } from "../interfaces.js"
import { pull, push, stableStringify } from "../protocol/index.js"
import { QUERY_CHECKPOINT, ERROR_HASH_MISMATCH, CONTENT_TYPE_JSON } from "../constants.js"

/** Reject path segments with traversal, null bytes, slashes, control chars */
const SAFE_PARAM = /^[a-zA-Z0-9._:@-]+$/
export function validatePathSegment(value: string): boolean {
  return SAFE_PARAM.test(value)
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

function deepSanitize(obj: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const key of Object.keys(obj)) {
    if (UNSAFE_KEYS.has(key)) continue
    const val = obj[key]
    if (val && typeof val === "object" && !Array.isArray(val)) {
      safe[key] = deepSanitize(val as Record<string, unknown>)
    } else {
      safe[key] = val
    }
  }
  return safe
}

/** Reject keys containing path traversal or control characters */
const UNSAFE_KEY = /\.\.|[\x00-\x1f]/

export async function handleSyncPull(
  c: Context,
  documentKey: string,
  store: IObjectStore,
  forceFullFetch = false,
  clientEncrypted = false,
): Promise<Response> {
  if (UNSAFE_KEY.test(documentKey)) {
    return c.json({ error: "Invalid path parameter" }, 400)
  }

  let checkpoint = 0
  if (!forceFullFetch && !clientEncrypted) {
    const checkpointParam = c.req.query(QUERY_CHECKPOINT)
    if (checkpointParam !== undefined) {
      const parsed = parseInt(checkpointParam, 10)
      if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== checkpointParam) {
        return c.json({ error: "Invalid checkpoint" }, 400)
      }
      checkpoint = parsed
    }
  }

  const result = await pull(store, documentKey, checkpoint)
  return c.json({
    data: result.data,
    hash: result.hash,
    timestamp: result.timestamp,
    ...(result.authorPubkey && { authorPubkey: result.authorPubkey }),
    ...(result.authorSignature && { authorSignature: result.authorSignature }),
  })
}

export type SignatureVerifier = (
  data: string,
  signature: string,
  pubkey: string
) => Promise<boolean>

export async function handleSyncPush(
  c: Context,
  documentKey: string,
  store: IObjectStore,
  identity?: string,
  verifySignature?: SignatureVerifier,
  skipTimestamps?: boolean,
): Promise<Response> {
  if (UNSAFE_KEY.test(documentKey)) {
    return c.json({ error: "Invalid path parameter" }, 400)
  }
  const contentType = c.req.header("content-type") ?? ""
  if (!contentType.includes(CONTENT_TYPE_JSON)) {
    return c.json({ error: `Content-Type must be ${CONTENT_TYPE_JSON}` }, 415)
  }

  const body = await c.req.json()

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Body must be a JSON object" }, 400)
  }

  const { data, baseHash, authorSignature } = body as {
    data?: unknown
    baseHash?: unknown
    authorSignature?: unknown
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return c.json({ error: "Missing or invalid data" }, 400)
  }

  if (baseHash !== null && typeof baseHash !== "string") {
    return c.json({ error: "baseHash must be a string or null" }, 400)
  }

  const sanitized = deepSanitize(data as Record<string, unknown>)

  // Verify and forward author signature if provided
  let author: { pubkey: string; signature: string } | undefined
  if (typeof authorSignature === "string" && identity && verifySignature) {
    const canonical = stableStringify(sanitized)
    const valid = await verifySignature(canonical, authorSignature, identity)
    if (!valid) {
      return c.json({ error: "Invalid author signature" }, 400)
    }
    author = { pubkey: identity, signature: authorSignature }
  }

  const result = await push(store, documentKey, sanitized, baseHash as string | null, author, skipTimestamps)

  if (!result.ok) {
    return c.json({ error: ERROR_HASH_MISMATCH }, 409)
  }

  return c.json({ hash: result.hash, timestamp: result.timestamp })
}
