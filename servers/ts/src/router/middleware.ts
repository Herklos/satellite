import type { MiddlewareHandler } from "hono"
import { IDENTITY_KEY } from "../constants.js"

export function bodyLimit(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const contentLength = c.req.header("content-length")
    if (contentLength) {
      const parsed = parseInt(contentLength, 10)
      if (!Number.isFinite(parsed) || parsed < 0) {
        return c.json({ error: "Invalid Content-Length" }, 400)
      }
      if (parsed > maxBytes) {
        return c.json({ error: "Payload too large" }, 413)
      }
    }
    await next()
  }
}

interface BucketEntry {
  count: number
  resetAt: number
}

export function rateLimitMiddleware(
  opts: { windowMs?: number; maxRequests?: number } = {}
): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000
  const maxRequests = opts.maxRequests ?? 100
  const buckets = new Map<string, BucketEntry>()

  return async (c, next) => {
    // Use authenticated identity if available, fall back to IP-based key
    const identity = c.get(IDENTITY_KEY) as string | undefined
    const bucketKey = identity ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "anonymous"

    const now = Date.now()
    let entry = buckets.get(bucketKey)

    if (!entry || entry.resetAt <= now) {
      for (const [key, val] of buckets) {
        if (val.resetAt <= now) buckets.delete(key)
      }
      entry = { count: 0, resetAt: now + windowMs }
      buckets.set(bucketKey, entry)
    }

    entry.count++

    if (entry.count > maxRequests) {
      return c.json({ error: "Rate limit exceeded" }, 429)
    }

    await next()
  }
}
