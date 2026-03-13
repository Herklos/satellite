"""AES-256-GCM encrypted object store wrapper."""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

from satellite_server.interfaces import IObjectStore
from satellite_server.constants import HKDF_INFO_DEFAULT

IV_BYTES = 12


def _derive_key(secret: str, salt: str, info: str) -> bytes:
    """Derive a 256-bit AES key from a secret and salt using HKDF(SHA-256)."""
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt.encode("utf-8"),
        info=info.encode("utf-8"),
    )
    return hkdf.derive(secret.encode("utf-8"))


class EncryptedObjectStore:
    """Wraps an IObjectStore to transparently encrypt/decrypt all values.

    Keys (paths) are NOT encrypted — only the stored content.
    """

    def __init__(
        self,
        inner: IObjectStore,
        secret: str,
        salt: str,
        info: str = HKDF_INFO_DEFAULT,
    ) -> None:
        self._inner = inner
        key = _derive_key(secret, salt, info)
        self._aesgcm = AESGCM(key)

    def _encrypt(self, plaintext: str) -> str:
        iv = os.urandom(IV_BYTES)
        data = plaintext.encode("utf-8")
        ciphertext = self._aesgcm.encrypt(iv, data, None)
        combined = iv + ciphertext
        return base64.b64encode(combined).decode("ascii")

    def _decrypt(self, encoded: str) -> str:
        combined = base64.b64decode(encoded)
        if len(combined) < IV_BYTES:
            raise ValueError("Encrypted data is too short")
        iv = combined[:IV_BYTES]
        ciphertext = combined[IV_BYTES:]
        try:
            plaintext = self._aesgcm.decrypt(iv, ciphertext, None)
        except Exception as exc:
            raise ValueError("Decryption failed: data may be tampered or key is incorrect") from exc
        return plaintext.decode("utf-8")

    async def get_string(self, key: str) -> str | None:
        raw = await self._inner.get_string(key)
        if raw is None:
            return None
        return self._decrypt(raw)

    async def put(
        self,
        key: str,
        body: str,
        *,
        content_type: str | None = None,
        cache_control: str | None = None,
    ) -> None:
        encrypted = self._encrypt(body)
        await self._inner.put(key, encrypted, content_type=content_type, cache_control=cache_control)

    async def list(
        self,
        prefix: str,
        *,
        start_after: str | None = None,
        limit: int | None = None,
    ) -> list[str]:
        return await self._inner.list(prefix, start_after=start_after, limit=limit)

    async def delete(self, key: str) -> None:
        await self._inner.delete(key)

    async def delete_many(self, keys: list[str]) -> None:
        await self._inner.delete_many(keys)
