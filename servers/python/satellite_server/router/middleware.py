"""Middleware utilities for FastAPI sync routes."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from fastapi import Request
from fastapi.responses import JSONResponse


def check_body_limit(content_length: int | None, max_bytes: int) -> JSONResponse | None:
    """Return an error response if the content length exceeds the limit."""
    if content_length is not None and content_length > max_bytes:
        return JSONResponse({"error": "Payload too large"}, status_code=413)
    return None


@dataclass
class _BucketEntry:
    count: int = 0
    reset_at: float = 0.0


class RateLimiter:
    """In-memory per-identity rate limiter."""

    def __init__(self, window_ms: int = 60_000, max_requests: int = 100) -> None:
        self._window_ms = window_ms
        self._max_requests = max_requests
        self._buckets: dict[str, _BucketEntry] = {}

    def check(self, identity: str | None) -> JSONResponse | None:
        """Return an error response if the rate limit is exceeded."""
        if not identity:
            return None

        now = time.time() * 1000
        entry = self._buckets.get(identity)

        if not entry or entry.reset_at <= now:
            # Clean up expired entries
            self._buckets = {
                k: v for k, v in self._buckets.items() if v.reset_at > now
            }
            entry = _BucketEntry(count=0, reset_at=now + self._window_ms)
            self._buckets[identity] = entry

        entry.count += 1

        if entry.count > self._max_requests:
            return JSONResponse({"error": "Rate limit exceeded"}, status_code=429)

        return None
