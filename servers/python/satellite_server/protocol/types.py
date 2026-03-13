"""Protocol types for the Satellite sync protocol."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union

# Timestamps can be a flat int (leaf) or a nested dict (object).
Timestamps = dict[str, Union[int, "Timestamps"]]

DOCUMENT_VERSION = 1


@dataclass
class StoredDocument:
    """On-disk format for a synced document."""

    v: int
    data: dict[str, Any]
    timestamps: Timestamps
    hash: str
    author_pubkey: str | None = None
    author_signature: str | None = None


@dataclass
class PullResult:
    """Result of a pull operation."""

    data: dict[str, Any]
    hash: str
    timestamp: int
    author_pubkey: str | None = None
    author_signature: str | None = None


@dataclass
class PushSuccess:
    """Successful push result."""

    hash: str
    timestamp: int


@dataclass
class PushConflict:
    """Failed push result due to hash mismatch."""

    error: str = field(default="hash_mismatch")


PushResult = PushSuccess | PushConflict
