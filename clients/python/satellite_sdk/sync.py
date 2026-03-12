"""High-level sync manager with automatic conflict resolution."""

from __future__ import annotations

from typing import Any, Callable

from .client import SatelliteClient
from .crypto import Encryptor, create_encryptor
from .hash import stable_stringify
from .types import ConflictError, ConflictResolver, DataSigner, PullResponse


def _default_merge(
    local: dict[str, Any], remote: dict[str, Any]
) -> dict[str, Any]:
    """Default deep-merge: remote wins on leaf conflicts."""
    merged = {**local}
    for key, remote_val in remote.items():
        local_val = merged.get(key)
        if isinstance(remote_val, dict) and isinstance(local_val, dict):
            merged[key] = _default_merge(local_val, remote_val)
        else:
            merged[key] = remote_val
    return merged


def _deep_assign(
    target: dict[str, Any], source: dict[str, Any]
) -> dict[str, Any]:
    """Deep assign source into target (mutates target)."""
    for key, src_val in source.items():
        tgt_val = target.get(key)
        if isinstance(src_val, dict) and isinstance(tgt_val, dict):
            _deep_assign(tgt_val, src_val)
        else:
            target[key] = src_val
    return target


class SyncManager:
    """High-level sync manager with pull, push, and automatic conflict resolution.

    Tracks the last known hash and checkpoint locally to support incremental sync
    and optimistic concurrency via hash-based conflict detection.
    """

    def __init__(
        self,
        client: SatelliteClient,
        pull_path: str,
        push_path: str,
        *,
        on_conflict: ConflictResolver | None = None,
        max_retries: int = 3,
        encryption_secret: str | None = None,
        encryption_salt: str | None = None,
        encryption_info: str = "satellite-e2e",
        sign_data: DataSigner | None = None,
    ) -> None:
        self._client = client
        self._pull_path = pull_path
        self._push_path = push_path
        self._on_conflict = on_conflict or _default_merge
        self._max_retries = max_retries
        self._sign_data = sign_data
        self._encryptor: Encryptor | None = (
            create_encryptor(encryption_secret, encryption_salt, encryption_info)
            if encryption_secret is not None and encryption_salt is not None
            else None
        )

        self._last_hash: str | None = None
        self._last_checkpoint: int = 0
        self._local_data: dict[str, Any] = {}

    @property
    def data(self) -> dict[str, Any]:
        """Current local data snapshot."""
        return {**self._local_data}

    @property
    def hash(self) -> str | None:
        """Last known remote hash."""
        return self._last_hash

    @property
    def checkpoint(self) -> int:
        """Last checkpoint timestamp."""
        return self._last_checkpoint

    async def pull(self) -> PullResponse:
        """Pull latest data from the server.

        Uses checkpoint for incremental sync if we've pulled before.
        """
        result = await self._client.pull(self._pull_path, self._last_checkpoint)

        if self._encryptor is not None:
            decrypted = self._encryptor.decrypt(result.data)
            self._local_data = decrypted
            result.data = decrypted
        elif self._last_checkpoint > 0:
            _deep_assign(self._local_data, result.data)
        else:
            self._local_data = result.data

        self._last_hash = result.hash
        self._last_checkpoint = result.timestamp
        return result

    async def push(self, data: dict[str, Any]) -> dict[str, Any]:
        """Push data with automatic conflict resolution.

        On conflict (409):
        1. Re-pulls remote data
        2. Calls the conflict resolver with local and remote data
        3. Re-pushes the merged result
        4. Retries up to max_retries times

        Returns:
            dict with "hash" and "timestamp" keys.
        """
        attempt = 0
        pending_data = data

        while attempt <= self._max_retries:
            try:
                payload = (
                    self._encryptor.encrypt(pending_data)
                    if self._encryptor is not None
                    else pending_data
                )

                sig = (
                    await self._sign_data(stable_stringify(pending_data))
                    if self._sign_data is not None
                    else None
                )

                result = await self._client.push(
                    self._push_path, payload, self._last_hash, sig
                )
                self._last_hash = result.hash
                self._last_checkpoint = result.timestamp
                self._local_data = pending_data
                return {"hash": result.hash, "timestamp": result.timestamp}
            except ConflictError:
                if attempt >= self._max_retries:
                    raise
                remote = await self._client.pull(self._pull_path)
                self._last_hash = remote.hash
                self._last_checkpoint = remote.timestamp

                remote_data = (
                    self._encryptor.decrypt(remote.data)
                    if self._encryptor is not None
                    else remote.data
                )
                pending_data = self._on_conflict(pending_data, remote_data)
                attempt += 1

        raise ConflictError()  # unreachable
