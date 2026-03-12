import type { MiddlewareHandler } from "hono"
import { IDENTITY_KEY } from "../constants.js"

export function bodyLimit(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const contentLength = c.req.header("content-length")
    if (contentLength) {
      if (parseInt(contentLength, 10) > maxBytes) {
        return c.json({ error: "Payload too large" }, 413)
      }
    } else if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const body = await c.req.text()
      if (body.length > maxBytes) {
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
    const identity = c.get(IDENTITY_KEY) as string | undefined
    if (!identity) {
      await next()
      return
    }

    const now = Date.now()
    let entry = buckets.get(identity)

    if (!entry || entry.resetAt <= now) {
      for (const [key, val] of buckets) {
        if (val.resetAt <= now) buckets.delete(key)
      }
      entry = { count: 0, resetAt: now + windowMs }
      buckets.set(identity, entry)
    }

    entry.count++

    if (entry.count > maxRequests) {
      return c.json({ error: "Rate limit exceeded" }, 429)
    }

    await next()
  }
}
