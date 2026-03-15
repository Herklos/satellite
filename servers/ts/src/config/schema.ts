import { z } from "zod"
import { ENCRYPTION_NONE, ENCRYPTION_IDENTITY, ENCRYPTION_SERVER, ENCRYPTION_DELEGATED } from "../constants.js"

export const EncryptionModeSchema = z.enum([ENCRYPTION_NONE, ENCRYPTION_IDENTITY, ENCRYPTION_SERVER, ENCRYPTION_DELEGATED])

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
})

export const RateLimitConfigSchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().positive(),
})

export const WildcardRemoteConfigSchema = z.object({
  url: z.string().min(1),
  pullPathTemplate: z.string().min(1),
  readRoles: z.array(z.string().min(1)),
  headers: z.record(z.string()).default({}),
  onPullMinIntervalMs: z.number().int().positive().optional(),
  negativeCacheMs: z.number().int().positive().default(300_000),
  maxBodyBytes: z.number().int().positive().default(65536),
})

export const SyncConfigSchema = z.object({
  version: z.literal(1),
  collections: z.array(CollectionConfigSchema),
  rateLimit: RateLimitConfigSchema.optional(),
  wildcardRemote: WildcardRemoteConfigSchema.optional(),
})

// Inferred types
export type EncryptionMode = z.infer<typeof EncryptionModeSchema>
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>
export type WildcardRemoteConfig = z.infer<typeof WildcardRemoteConfigSchema>
export type SyncConfig = z.infer<typeof SyncConfigSchema>
