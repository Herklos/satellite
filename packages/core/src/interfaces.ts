/**
 * Object / blob storage interface.
 * Implementations: S3, R2, MongoDB GridFS, in-memory (testing).
 */
export interface IObjectStore {
  /** Returns the object body as a string, or null if not found */
  getString(key: string): Promise<string | null>

  /** Put an object. Options are applied as HTTP headers where supported. */
  put(
    key: string,
    body: string,
    opts?: { contentType?: string; cacheControl?: string }
  ): Promise<void>

  /**
   * List object keys under a prefix.
   * startAfter is exclusive (S3 StartAfter / R2 cursor semantics).
   */
  list(
    prefix: string,
    opts?: { startAfter?: string; limit?: number }
  ): Promise<string[]>

  /** Delete a single key */
  del(key: string): Promise<void>

  /** Delete multiple keys in one operation where supported */
  delMany(keys: string[]): Promise<void>
}
