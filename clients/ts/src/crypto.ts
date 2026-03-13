/**
 * Client-side AES-256-GCM encryption for end-to-end encrypted sync.
 *
 * Key derivation uses HKDF(SHA-256) with a secret and salt,
 * matching the server-side EncryptedObjectStore pattern.
 */

import { getCrypto, getBase64 } from "./platform.js"

const ALGO = "AES-GCM"
const IV_BYTES = 12
const DEFAULT_INFO = "satellite-e2e"

/** Key used in the encrypted wire-format wrapper object. */
export const ENCRYPTED_KEY = "_encrypted"

/** Encrypt/decrypt interface for client-side E2E encryption. */
export interface Encryptor {
  encrypt(data: Record<string, unknown>): Promise<Record<string, unknown>>
  decrypt(wrapper: Record<string, unknown>): Promise<Record<string, unknown>>
}

async function deriveKey(secret: string, salt: string, info: string): Promise<CryptoKey> {
  const enc = new TextEncoder()
  const c = getCrypto()
  const keyMaterial = await c.subtle.importKey(
    "raw",
    enc.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  )
  return c.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(salt),
      info: enc.encode(info),
    },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * Creates an Encryptor that uses AES-256-GCM with HKDF-derived keys.
 *
 * @param secret - Secret string for key derivation.
 * @param salt - Salt for HKDF (typically the user's identity).
 * @param info - HKDF info string for domain separation (default: "satellite-e2e").
 */
export function createEncryptor(secret: string, salt: string, info: string = DEFAULT_INFO): Encryptor {
  const keyPromise = deriveKey(secret, salt, info)

  return {
    async encrypt(data: Record<string, unknown>): Promise<Record<string, unknown>> {
      const key = await keyPromise
      const c = getCrypto()
      const b64 = getBase64()
      const plaintext = new TextEncoder().encode(JSON.stringify(data))
      const iv = c.getRandomValues(new Uint8Array(IV_BYTES))
      const ciphertext = await c.subtle.encrypt({ name: ALGO, iv }, key, plaintext)

      const combined = new Uint8Array(iv.length + ciphertext.byteLength)
      combined.set(iv)
      combined.set(new Uint8Array(ciphertext), iv.length)

      return { [ENCRYPTED_KEY]: b64.encode(combined) }
    },

    async decrypt(wrapper: Record<string, unknown>): Promise<Record<string, unknown>> {
      const encoded = wrapper[ENCRYPTED_KEY]
      if (typeof encoded !== "string") {
        throw new Error("Expected encrypted data but received unencrypted document")
      }

      const key = await keyPromise
      const c = getCrypto()
      const b64 = getBase64()
      const combined = b64.decode(encoded)
      if (combined.length < IV_BYTES) {
        throw new Error("Encrypted data is too short")
      }
      const iv = combined.slice(0, IV_BYTES)
      const ciphertext = combined.slice(IV_BYTES)
      try {
        const plaintext = await c.subtle.decrypt({ name: ALGO, iv }, key, ciphertext)
        return JSON.parse(new TextDecoder().decode(plaintext))
      } catch (err) {
        throw new Error("Decryption failed: data may be tampered or key is incorrect", { cause: err })
      }
    },
  }
}
