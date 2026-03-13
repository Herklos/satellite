import { Hono } from "hono"
import type { MiddlewareHandler, Context } from "hono"
import type { IObjectStore } from "../interfaces.js"
import type { SyncConfig, CollectionConfig } from "../config/schema.js"
import { EncryptedObjectStore } from "../encryption/encrypted-store.js"
import { pull } from "../protocol/index.js"
import { handleSyncPull, handleSyncPush, validatePathSegment } from "./helpers.js"
import type { SignatureVerifier } from "./helpers.js"
import { bodyLimit, rateLimitMiddleware } from "./middleware.js"
import {
  ROLE_PUBLIC,
  ROLE_SELF,
  OP_READ,
  OP_WRITE,
  ENCRYPTION_IDENTITY,
  ENCRYPTION_SERVER,
  ENCRYPTION_DELEGATED,
  ACTION_PULL,
  ACTION_PUSH,
  IDENTITY_PARAM,
  IDENTITY_KEY,
  QUERY_CHECKPOINT,
  HKDF_INFO_IDENTITY,
  HKDF_INFO_SERVER,
  HKDF_INFO_DELEGATED,
  HEADER_ENCRYPTION_SECRET,
  HEADER_ENCRYPTION_SALT,
} from "../constants.js"
import type { AccessOperation } from "../constants.js"

// ── Types ────────────────────────────────────────────────────────────────

export interface AuthResult {
  identity: string
  roles: string[]
}

export type RoleResolver = (req: Request) => Promise<AuthResult>

export type RoleEnricher = (
  auth: AuthResult,
  params: Record<string, string>
) => Promise<string[]>

export interface SyncRouterOptions {
  store: IObjectStore
  config: SyncConfig
  roleResolver: RoleResolver
  roleEnricher?: RoleEnricher
  encryptionSecret?: string
  serverEncryptionSecret?: string
  serverIdentity?: string
  identityEncryptionInfo?: string
  serverEncryptionInfo?: string
  signatureVerifier?: SignatureVerifier
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert config storagePath template to a Hono route path.
 * "users/{identity}/invoices" -> "/users/:identity/invoices"
 * Prefixed with /pull or /push.
 */
function toRoutePath(action: string, storagePath: string): string {
  const honoParts = storagePath.replace(/\{(\w+)\}/g, ":$1")
  return `/${action}/${honoParts}`
}

/**
 * Resolve a storage path template into a document key.
 * "users/{identity}/invoices" + { identity: "abc" } -> "users/abc/invoices"
 */
function resolveDocumentKey(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? "")
}

function validateAllParams(params: Record<string, string>): boolean {
  for (const value of Object.values(params)) {
    if (!validatePathSegment(value)) return false
  }
  return true
}

/**
 * Compose an array of middleware + handler into a single handler.
 */
function compose(
  middlewares: MiddlewareHandler[],
  handler: (c: Context) => Promise<Response>,
): MiddlewareHandler {
  return async (c, _next) => {
    let idx = 0
    const run = async (): Promise<void> => {
      if (idx < middlewares.length) {
        const mw = middlewares[idx++]!
        const result = await mw(c, run)
        if (result instanceof Response) {
          c.res = result
        }
      } else {
        c.res = await handler(c)
      }
    }
    await run()
  }
}

// ── Auth middleware ───────────────────────────────────────────────────────

/**
 * Build auth middleware for a given collection and operation (read/write).
 * Handles: public access, role resolution, "self" auto-grant, role enrichment.
 */
function buildAuthMiddleware(
  col: CollectionConfig,
  operation: AccessOperation,
  opts: SyncRouterOptions,
): MiddlewareHandler | null {
  const requiredRoles = operation === OP_READ ? col.readRoles : col.writeRoles

  // Public access — no auth needed
  if (requiredRoles.includes(ROLE_PUBLIC)) return null

  return async (c, next) => {
    let auth: AuthResult
    try {
      auth = await opts.roleResolver(c.req.raw)
    } catch {
      return c.json({ error: "Unauthorized" }, 401)
    }

    // Store identity in context for downstream use (rate limiting, encryption)
    c.set(IDENTITY_KEY, auth.identity)

    const effectiveRoles = new Set(auth.roles)

    // Auto-grant "self" when {identity} in path matches authenticated identity
    if (col.storagePath.includes(IDENTITY_PARAM)) {
      const params = c.req.param() as Record<string, string>
      if (params[IDENTITY_KEY] === auth.identity) {
        effectiveRoles.add(ROLE_SELF)
      }
    }

    // Enrich roles with context-dependent roles (e.g. "owner")
    if (opts.roleEnricher) {
      const params = c.req.param() as Record<string, string>
      const extra = await opts.roleEnricher(auth, params)
      for (const role of extra) effectiveRoles.add(role)
    }

    // Check if any effective role matches the required roles
    const hasAccess = requiredRoles.some(r => effectiveRoles.has(r))
    if (!hasAccess) {
      return c.json({ error: "Forbidden" }, 403)
    }

    await next()
  }
}

// ── Store resolution ─────────────────────────────────────────────────────

function resolveStore(
  col: CollectionConfig,
  baseStore: IObjectStore,
  params: Record<string, string>,
  identity: string | undefined,
  opts: SyncRouterOptions,
  req?: Request,
): IObjectStore | Response {
  if (col.encryption === ENCRYPTION_IDENTITY) {
    if (!opts.encryptionSecret) throw new Error(`Collection "${col.name}" requires encryptionSecret`)
    const salt = identity ?? params[IDENTITY_KEY] ?? ""
    return new EncryptedObjectStore(
      baseStore,
      opts.encryptionSecret,
      salt,
      opts.identityEncryptionInfo ?? HKDF_INFO_IDENTITY,
    )
  }
  if (col.encryption === ENCRYPTION_SERVER) {
    if (!opts.serverEncryptionSecret) throw new Error(`Collection "${col.name}" requires serverEncryptionSecret`)
    if (!opts.serverIdentity) throw new Error(`Collection "${col.name}" requires serverIdentity`)
    return new EncryptedObjectStore(
      baseStore,
      opts.serverEncryptionSecret,
      opts.serverIdentity,
      opts.serverEncryptionInfo ?? HKDF_INFO_SERVER,
    )
  }
  if (col.encryption === ENCRYPTION_DELEGATED) {
    const secret = req?.headers.get(HEADER_ENCRYPTION_SECRET)
    const salt = req?.headers.get(HEADER_ENCRYPTION_SALT)
    if (!secret || !salt) {
      return Response.json(
        { error: "Delegated encryption requires X-Encryption-Secret and X-Encryption-Salt headers" },
        { status: 400 },
      )
    }
    return new EncryptedObjectStore(
      baseStore,
      secret,
      salt,
      HKDF_INFO_DELEGATED,
    )
  }
  return baseStore
}

// ── Route building ───────────────────────────────────────────────────────

function addCollectionRoutes(router: Hono, col: CollectionConfig, opts: SyncRouterOptions): void {
  // Pull route
  if (!col.pushOnly) {
    const pullPath = toRoutePath(ACTION_PULL, col.storagePath)
    const authMw = buildAuthMiddleware(col, OP_READ, opts)
    const middlewares: MiddlewareHandler[] = authMw ? [authMw] : []

    const handler = async (c: Context) => {
      const params = c.req.param() as Record<string, string>
      if (!validateAllParams(params)) {
        return c.json({ error: "Invalid path parameter" }, 400)
      }
      const documentKey = resolveDocumentKey(col.storagePath, params)
      const identity = (c.get(IDENTITY_KEY) as string | undefined)
      const storeOrError = resolveStore(col, opts.store, params, identity, opts, c.req.raw)
      if (storeOrError instanceof Response) return storeOrError
      return handleSyncPull(c, documentKey, storeOrError, col.forceFullFetch, col.clientEncrypted)
    }

    router.get(pullPath, compose(middlewares, handler))
  }

  // Push route
  if (!col.pullOnly) {
    const pushPath = toRoutePath(ACTION_PUSH, col.storagePath)
    const middlewares: MiddlewareHandler[] = []

    const authMw = buildAuthMiddleware(col, OP_WRITE, opts)
    if (authMw) middlewares.push(authMw)
    middlewares.push(bodyLimit(col.maxBodyBytes))
    if (col.rateLimit && opts.config.rateLimit) {
      middlewares.push(rateLimitMiddleware(opts.config.rateLimit))
    }

    const handler = async (c: Context) => {
      const params = c.req.param() as Record<string, string>
      if (!validateAllParams(params)) {
        return c.json({ error: "Invalid path parameter" }, 400)
      }
      const documentKey = resolveDocumentKey(col.storagePath, params)
      const identity = (c.get(IDENTITY_KEY) as string | undefined)
      const storeOrError = resolveStore(col, opts.store, params, identity, opts, c.req.raw)
      if (storeOrError instanceof Response) return storeOrError
      return handleSyncPush(c, documentKey, storeOrError, identity, opts.signatureVerifier, col.clientEncrypted)
    }

    router.post(pushPath, compose(middlewares, handler))
  }
}

function addBundledRoutes(router: Hono, bundleName: string, collections: CollectionConfig[], opts: SyncRouterOptions): void {
  const storagePath = collections[0]!.storagePath

  // Pull: combined pull for all collections in the bundle
  const pullPath = toRoutePath(ACTION_PULL, storagePath)
  const isAnyPublic = collections.some(c => c.readRoles.includes(ROLE_PUBLIC))
  const pullAuthMw = isAnyPublic ? null : buildAuthMiddleware(collections[0]!, OP_READ, opts)
  const pullMiddlewares: MiddlewareHandler[] = pullAuthMw ? [pullAuthMw] : []

  const pullHandler = async (c: Context) => {
    const params = c.req.param() as Record<string, string>
    if (!validateAllParams(params)) {
      return c.json({ error: "Invalid path parameter" }, 400)
    }
    const baseKey = resolveDocumentKey(storagePath, params)
    const identity = (c.get(IDENTITY_KEY) as string | undefined)
    const storeOrError = resolveStore(collections[0]!, opts.store, params, identity, opts, c.req.raw)
    if (storeOrError instanceof Response) return storeOrError
    const store = storeOrError

    const anyClientEncrypted = collections.some(c => c.clientEncrypted)
    const checkpointParam = c.req.query(QUERY_CHECKPOINT)
    let checkpoint = 0
    if (!anyClientEncrypted && checkpointParam !== undefined) {
      const parsed = parseInt(checkpointParam, 10)
      if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== checkpointParam) {
        return c.json({ error: "Invalid checkpoint" }, 400)
      }
      checkpoint = parsed
    }

    // Pull each collection as a separate document under the bundle key
    const result: Record<string, unknown> = {}
    let latestTimestamp = 0

    for (const col of collections) {
      const documentKey = `${baseKey}/${col.name}`
      const pullResult = await pull(store, documentKey, checkpoint)
      result[col.name] = {
        data: pullResult.data,
        hash: pullResult.hash,
      }
      if (pullResult.timestamp > latestTimestamp) latestTimestamp = pullResult.timestamp
    }

    return c.json({ collections: result, timestamp: latestTimestamp })
  }

  router.get(pullPath, compose(pullMiddlewares, pullHandler))

  // Push: individual push per collection in the bundle
  for (const col of collections) {
    if (col.pullOnly) continue

    const pushPath = toRoutePath(ACTION_PUSH, storagePath) + `/${col.name}`
    const middlewares: MiddlewareHandler[] = []
    const authMw = buildAuthMiddleware(col, OP_WRITE, opts)
    if (authMw) middlewares.push(authMw)
    middlewares.push(bodyLimit(col.maxBodyBytes))
    if (col.rateLimit && opts.config.rateLimit) {
      middlewares.push(rateLimitMiddleware(opts.config.rateLimit))
    }

    const handler = async (c: Context) => {
      const params = c.req.param() as Record<string, string>
      if (!validateAllParams(params)) {
        return c.json({ error: "Invalid path parameter" }, 400)
      }
      const documentKey = `${resolveDocumentKey(storagePath, params)}/${col.name}`
      const identity = (c.get(IDENTITY_KEY) as string | undefined)
      const storeOrError = resolveStore(col, opts.store, params, identity, opts, c.req.raw)
      if (storeOrError instanceof Response) return storeOrError
      return handleSyncPush(c, documentKey, storeOrError, identity, opts.signatureVerifier, col.clientEncrypted)
    }

    router.post(pushPath, compose(middlewares, handler))
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export function createSyncRouter(opts: SyncRouterOptions): Hono {
  const router = new Hono()
  const { config } = opts

  // Group bundled collections
  const bundles = new Map<string, CollectionConfig[]>()
  const standalone: CollectionConfig[] = []

  for (const col of config.collections) {
    if (col.bundle) {
      const list = bundles.get(col.bundle) ?? []
      list.push(col)
      bundles.set(col.bundle, list)
    } else {
      standalone.push(col)
    }
  }

  for (const col of standalone) {
    addCollectionRoutes(router, col, opts)
  }

  for (const [bundleName, collections] of bundles) {
    addBundledRoutes(router, bundleName, collections, opts)
  }

  return router
}
