// Constants
export {
  ROLE_PUBLIC,
  ROLE_SELF,
  OP_READ,
  OP_WRITE,
  ENCRYPTION_NONE,
  ENCRYPTION_IDENTITY,
  ENCRYPTION_SERVER,
  ACTION_PULL,
  ACTION_PUSH,
  IDENTITY_PARAM,
  IDENTITY_KEY,
  QUERY_CHECKPOINT,
  HKDF_INFO_DEFAULT,
  HKDF_INFO_IDENTITY,
  HKDF_INFO_SERVER,
  DEFAULT_CONFIG_KEY,
  ERROR_HASH_MISMATCH,
  CONTENT_TYPE_JSON,
} from "./constants.js"
export type { AccessOperation } from "./constants.js"

// Interfaces
export type { IObjectStore } from "./interfaces.js"

// Errors
export { StartupError, AuthError, ConflictError, NotFoundError } from "./errors.js"

// Timestamp
export { nextTimestamp } from "./timestamp.js"

// Protocol
export {
  pull,
  push,
  stableStringify,
  computeHash,
  computeTimestamps,
  filterByCheckpoint,
} from "./protocol/index.js"
export type {
  Timestamps,
  StoredDocument,
  PullResult,
  PushResult,
} from "./protocol/index.js"

// Encryption
export { EncryptedObjectStore } from "./encryption/index.js"

// Config
export {
  SyncConfigSchema,
  CollectionConfigSchema,
  EncryptionModeSchema,
  RateLimitConfigSchema,
  loadConfig,
  saveConfig,
  validateConfig,
} from "./config/index.js"
export type {
  SyncConfig,
  CollectionConfig,
  EncryptionMode,
  RateLimitConfig,
} from "./config/index.js"
