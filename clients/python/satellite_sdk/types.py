"""Types for the Satellite sync protocol."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol


@dataclass
class PullResponse:
    """Response from a pull request."""
    data: dict[str, Any]
    hash: str
    timestamp: int
    author_pubkey: str | None = None
    author_signature: str | None = None


@dataclass
class PushSuccess:
    """Response from a successful push."""
    hash: str
    timestamp: int


class ConflictError(Exception):
    """Push conflict error (HTTP 409 — hash mismatch)."""

    def __init__(self) -> None:
        super().__init__("hash_mismatch")


class SatelliteHttpError(Exception):
    """HTTP error from the Satellite server."""

    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body}")


class AuthProvider(Protocol):
    """Auth provider: returns headers to include in requests."""

    async def __call__(
        self, *, method: str, path: str, body: str | None
    ) -> dict[str, str]: ...


class DataSigner(Protocol):
    """Signs data for author provenance."""

    async def __call__(self, data: str) -> str: ...


ConflictResolver = Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
