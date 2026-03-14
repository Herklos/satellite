import { z } from "zod"
import { ENCRYPTION_NONE, ENCRYPTION_IDENTITY, ENCRYPTION_SERVER, ENCRYPTION_DELEGATED } from "../constants.js"

export const EncryptionModeSchema = z.enum([ENCRYPTION_NONE, ENCRYPTION_IDENTITY, ENCRYPTION_SERVER, ENCRYPTION_DELEGATED])

/**
 * Configuration for syncing a collection from a remote (primary) satellite server.
 * When set, the local server acts as a replica for this collection.
 */
export const RemoteSourceSchema = z.object({
  /** Base URL of the primary satellite server (e.g. "https://primary.example.com/v1"). */
  url: z.string().url(),
  /** Pull path on the primary (e.g. "/pull/posts/featured"). Must be a static path with no template variables. */
  pullPath: z.string().min(1),
  /** How often to sync from the primary, in milliseconds. Defaults to 60 000 (1 minute). */
  intervalMs: z.number().int().positive().default(60_000),
  /** Static HTTP headers to send to the primary (e.g. for authentication). */
  headers: z.record(z.string()).optional(),
})

export const CollectionConfigSchema = z.object({
  name: z.string().min(1),
  storagePath: z.string().min(1),
  readRoles: z.array(z.string().min(1)),
  writeRoles: z.array(z.string().min(1)),
  encryption: EncryptionModeSchema,
  maxBodyBytes: z.number().int().positive(),
  rateLimit: z.boolean().optional(),
  pullOnly: z.boolean().optional(),
  pushOnly: z.boolean().optional(),
  forceFullFetch: z.boolean().optional(),
  clientEncrypted: z.boolean().optional(),
  bundle: z.string().min(1).optional(),
  /**
   * When set, this server replicates the collection from a remote primary satellite.
   * The collection becomes effectively read-only for local clients (pullOnly is implied).
   */
  remote: RemoteSourceSchema.optional(),
})

export const RateLimitConfigSchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().positive(),
})

export const SyncConfigSchema = z.object({
  version: z.literal(1),
  collections: z.array(CollectionConfigSchema),
  rateLimit: RateLimitConfigSchema.optional(),
})

// Inferred types
export type EncryptionMode = z.infer<typeof EncryptionModeSchema>
export type RemoteSource = z.infer<typeof RemoteSourceSchema>
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>
export type SyncConfig = z.infer<typeof SyncConfigSchema>
