import { describe, it, expect } from "vitest"
import { createEncryptor, ENCRYPTED_KEY } from "../src/crypto.js"
import vectors from "../../test-vectors/crypto.json"

describe("Encryptor", () => {
  it("round-trips data through encrypt/decrypt", async () => {
    const enc = createEncryptor("test-secret", "test-salt")
    const data = { hello: "world", num: 42 }

    const encrypted = await enc.encrypt(data)
    expect(encrypted).toHaveProperty(ENCRYPTED_KEY)
    expect(typeof encrypted[ENCRYPTED_KEY]).toBe("string")

    const decrypted = await enc.decrypt(encrypted)
    expect(decrypted).toEqual(data)
  })

  it("decrypt returns non-encrypted data as-is", async () => {
    const enc = createEncryptor("test-secret", "test-salt")
    const plain = { plain: "data" }

    const result = await enc.decrypt(plain)
    expect(result).toEqual(plain)
  })

  it("different secrets produce different ciphertext", async () => {
    const enc1 = createEncryptor("secret-1", "salt")
    const enc2 = createEncryptor("secret-2", "salt")
    const data = { key: "value" }

    const encrypted = await enc1.encrypt(data)
    // enc2 should fail to decrypt enc1's data
    await expect(enc2.decrypt(encrypted)).rejects.toThrow()
  })

  it("different salts produce different keys", async () => {
    const enc1 = createEncryptor("secret", "salt-1")
    const enc2 = createEncryptor("secret", "salt-2")
    const data = { key: "value" }

    const encrypted = await enc1.encrypt(data)
    await expect(enc2.decrypt(encrypted)).rejects.toThrow()
  })

  it("custom info string works", async () => {
    const enc = createEncryptor("secret", "salt", "custom-info")
    const data = { custom: true }

    const encrypted = await enc.encrypt(data)
    const decrypted = await enc.decrypt(encrypted)
    expect(decrypted).toEqual(data)
  })
})

describe("Encryptor (test vectors)", () => {
  const enc = createEncryptor(vectors.secret, vectors.salt)

  for (const vector of vectors.vectors) {
    it(`decrypts ${JSON.stringify(vector.plaintext).slice(0, 60)}`, async () => {
      const wrapper = { [ENCRYPTED_KEY]: vector.encrypted }
      const decrypted = await enc.decrypt(wrapper)
      expect(decrypted).toEqual(vector.plaintext)
    })
  }
})
