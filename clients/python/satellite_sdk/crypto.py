"""Client-side AES-256-GCM encryption for end-to-end encrypted sync.

Key derivation uses HKDF(SHA-256) with a secret and salt,
matching the server-side EncryptedObjectStore pattern.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

IV_BYTES = 12
DEFAULT_INFO = b"satellite-e2e"

ENCRYPTED_KEY = "_encrypted"


def _derive_key(secret: str, salt: str, info: bytes = DEFAULT_INFO) -> bytes:
    """Derive a 256-bit AES key from a secret and salt using HKDF(SHA-256)."""
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt.encode("utf-8"),
        info=info,
    )
    return hkdf.derive(secret.encode("utf-8"))


class Encryptor:
    """AES-256-GCM encryptor with HKDF-derived keys for client-side E2E encryption."""

    def __init__(
        self, secret: str, salt: str, info: str = "satellite-e2e"
    ) -> None:
        key = _derive_key(secret, salt, info.encode("utf-8"))
        self._aesgcm = AESGCM(key)

    def encrypt(self, data: dict[str, Any]) -> dict[str, Any]:
        """Encrypt a plaintext data dict into ``{ _encrypted: "<base64>" }``."""
        plaintext = json.dumps(data).encode("utf-8")
        iv = os.urandom(IV_BYTES)
        ciphertext = self._aesgcm.encrypt(iv, plaintext, None)
        combined = iv + ciphertext
        encoded = base64.b64encode(combined).decode("ascii")
        return {ENCRYPTED_KEY: encoded}

    def decrypt(self, wrapper: dict[str, Any]) -> dict[str, Any]:
        """Decrypt an encrypted wrapper back to the original data dict.

        Returns *wrapper* as-is if it does not contain the encrypted key.
        """
        encoded = wrapper.get(ENCRYPTED_KEY)
        if not isinstance(encoded, str):
            return wrapper

        combined = base64.b64decode(encoded)
        iv = combined[:IV_BYTES]
        ciphertext = combined[IV_BYTES:]
        plaintext = self._aesgcm.decrypt(iv, ciphertext, None)
        return json.loads(plaintext.decode("utf-8"))


def create_encryptor(
    secret: str, salt: str, info: str = "satellite-e2e"
) -> Encryptor:
    """Create an Encryptor using AES-256-GCM with HKDF-derived keys.

    Args:
        secret: Secret string for key derivation.
        salt: Salt for HKDF (typically the user's identity).
        info: HKDF info string for domain separation (default: "satellite-e2e").
    """
    return Encryptor(secret, salt, info)
