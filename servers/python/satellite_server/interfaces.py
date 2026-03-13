"""Object / blob storage interface."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class IObjectStore(Protocol):
    """Storage backend interface.

    Implementations: S3, R2, in-memory (testing).
    """

    async def get_string(self, key: str) -> str | None:
        """Return the object body as a string, or None if not found."""
        ...

    async def put(
        self,
        key: str,
        body: str,
        *,
        content_type: str | None = None,
        cache_control: str | None = None,
    ) -> None:
        """Put an object."""
        ...

    async def list(
        self,
        prefix: str,
        *,
        start_after: str | None = None,
        limit: int | None = None,
    ) -> list[str]:
        """List object keys under a prefix."""
        ...

    async def delete(self, key: str) -> None:
        """Delete a single key."""
        ...

    async def delete_many(self, keys: list[str]) -> None:
        """Delete multiple keys in one operation."""
        ...
