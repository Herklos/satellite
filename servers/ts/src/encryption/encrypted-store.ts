import type { IObjectStore } from "../interfaces.js"
import { HKDF_INFO_DEFAULT } from "../constants.js"

const ALGO = "AES-GCM"
const IV_BYTES = 12

/**
 * Derives an AES-256-GCM key from a secret and salt using HKDF-SHA-256.
 */
async function deriveKey(secret: string, salt: string, info: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode(info) },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const data = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, data)
  // Concatenate iv + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

async function decrypt(key: CryptoKey, encoded: string): Promise<string> {
  const combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
  if (combined.length < IV_BYTES) {
    throw new Error("Encrypted data is too short")
  }
  const iv = combined.slice(0, IV_BYTES)
  const ciphertext = combined.slice(IV_BYTES)
  try {
    const plaintext = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext)
    return new TextDecoder().decode(plaintext)
  } catch (err) {
    throw new Error("Decryption failed: data may be tampered or key is incorrect", { cause: err })
  }
}

/**
 * Wraps an IObjectStore to transparently encrypt/decrypt all values.
 * Keys (paths) are NOT encrypted — only the stored content.
 *
 * @param inner - The underlying store to delegate to
 * @param secret - Server-side encryption secret
 * @param salt - Per-identity salt (e.g. user pubkey, user ID)
 * @param info - HKDF info string for domain separation
 */
export class EncryptedObjectStore implements IObjectStore {
  private keyPromise: Promise<CryptoKey>

  constructor(
    private inner: IObjectStore,
    secret: string,
    salt: string,
    info: string = HKDF_INFO_DEFAULT
  ) {
    this.keyPromise = deriveKey(secret, salt, info)
  }

  async getString(key: string): Promise<string | null> {
    const raw = await this.inner.getString(key)
    if (raw === null) return null
    const k = await this.keyPromise
    return decrypt(k, raw)
  }

  async put(key: string, body: string, opts?: { contentType?: string; cacheControl?: string }): Promise<void> {
    const k = await this.keyPromise
    const encrypted = await encrypt(k, body)
    await this.inner.put(key, encrypted, opts)
  }

  async list(prefix: string, opts?: { startAfter?: string; limit?: number }): Promise<string[]> {
    return this.inner.list(prefix, opts)
  }

  async del(key: string): Promise<void> {
    return this.inner.del(key)
  }

  async delMany(keys: string[]): Promise<void> {
    return this.inner.delMany(keys)
  }
}
