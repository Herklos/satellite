/** Async key-value storage for SyncManager persistence. */
export interface StorageProvider {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Factory that creates a scoped StorageProvider for a given namespace. */
export type StorageFactory = (namespace: string) => StorageProvider
