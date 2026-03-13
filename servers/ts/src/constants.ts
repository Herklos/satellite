// ── Roles ────────────────────────────────────────────────────────────────

/** Role granting access without authentication. */
export const ROLE_PUBLIC = "public"

/** Role auto-granted when {identity} in URL matches the authenticated user. */
export const ROLE_SELF = "self"

// ── Access operations ────────────────────────────────────────────────────

export const OP_READ = "read" as const
export const OP_WRITE = "write" as const
export type AccessOperation = typeof OP_READ | typeof OP_WRITE

// ── Encryption modes ─────────────────────────────────────────────────────

export const ENCRYPTION_NONE = "none" as const
export const ENCRYPTION_IDENTITY = "identity" as const
export const ENCRYPTION_SERVER = "server" as const
export type EncryptionMode = typeof ENCRYPTION_NONE | typeof ENCRYPTION_IDENTITY | typeof ENCRYPTION_SERVER

// ── Route actions ────────────────────────────────────────────────────────

export const ACTION_PULL = "pull"
export const ACTION_PUSH = "push"

// ── Path params ──────────────────────────────────────────────────────────

/** Template placeholder for identity in storagePath. */
export const IDENTITY_PARAM = "{identity}"

/** Hono route param name for identity. */
export const IDENTITY_KEY = "identity"

/** Query parameter for incremental sync checkpoint. */
export const QUERY_CHECKPOINT = "checkpoint"

// ── HKDF info strings (domain separation) ────────────────────────────────

export const HKDF_INFO_DEFAULT = "satellite-data"
export const HKDF_INFO_IDENTITY = "satellite-identity-data"
export const HKDF_INFO_SERVER = "satellite-server-data"

// ── Config ───────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG_KEY = "__sync__/config.json"

// ── Protocol ─────────────────────────────────────────────────────────────

export const ERROR_HASH_MISMATCH = "hash_mismatch"
export const CONTENT_TYPE_JSON = "application/json"
