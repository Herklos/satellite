export { configurePlatform } from "./platform.js"
export type { CryptoProvider, Base64Provider, PlatformConfig } from "./platform.js"

export { SatelliteClient } from "./client.js"
export { SyncManager } from "./sync.js"
export type { SyncManagerOptions } from "./sync.js"
export { stableStringify, computeHash } from "./hash.js"
export { createEncryptor, ENCRYPTED_KEY } from "./crypto.js"
export type { Encryptor } from "./crypto.js"
export {
  ConflictError,
  SatelliteHttpError,
} from "./types.js"
export type {
  PullResponse,
  PushSuccess,
  SatelliteClientOptions,
  AuthProvider,
  ConflictResolver,
} from "./types.js"
