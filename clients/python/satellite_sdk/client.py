"""Low-level HTTP client for the Satellite sync protocol."""

from __future__ import annotations

import json
from typing import Any

import httpx

from .types import (
    AuthProvider,
    ConflictError,
    PullResponse,
    PushSuccess,
    SatelliteHttpError,
)


class SatelliteClient:
    """Low-level HTTP client for the Satellite sync protocol.

    Handles auth headers and response parsing.
    """

    def __init__(
        self,
        base_url: str,
        *,
        auth: AuthProvider | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._auth = auth
        self._client = client or httpx.AsyncClient()

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> "SatelliteClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def _auth_headers(
        self, method: str, path: str, body: str | None
    ) -> dict[str, str]:
        if self._auth is None:
            return {}
        return await self._auth(method=method, path=path, body=body)

    async def pull(
        self, path: str, checkpoint: int | None = None
    ) -> PullResponse:
        """Pull synced data from the server.

        Args:
            path: The pull endpoint path (e.g. "/pull/users/abc/settings")
            checkpoint: Only return data updated after this timestamp (0 = full pull)
        """
        params: dict[str, str] = {}
        if checkpoint is not None and checkpoint > 0:
            params["checkpoint"] = str(checkpoint)

        auth_headers = await self._auth_headers("GET", path, None)

        resp = await self._client.get(
            f"{self._base_url}{path}",
            params=params,
            headers={"Accept": "application/json", **auth_headers},
        )
        if resp.status_code != 200:
            raise SatelliteHttpError(resp.status_code, resp.text)

        body = resp.json()
        return PullResponse(
            data=body["data"],
            hash=body["hash"],
            timestamp=body["timestamp"],
            author_pubkey=body.get("authorPubkey"),
            author_signature=body.get("authorSignature"),
        )

    async def push(
        self,
        path: str,
        data: dict[str, Any],
        base_hash: str | None,
        author_signature: str | None = None,
    ) -> PushSuccess:
        """Push synced data to the server.

        Args:
            path: The push endpoint path
            data: The full document data to push
            base_hash: Hash of the document this push is based on (None for first push)
            author_signature: Optional author signature for provenance

        Raises:
            ConflictError: if the server detects a hash mismatch (409)
        """
        payload: dict[str, Any] = {"data": data, "baseHash": base_hash}
        if author_signature is not None:
            payload["authorSignature"] = author_signature
        body = json.dumps(payload)

        auth_headers = await self._auth_headers("POST", path, body)

        resp = await self._client.post(
            f"{self._base_url}{path}",
            content=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                **auth_headers,
            },
        )

        if resp.status_code == 409:
            raise ConflictError()
        if resp.status_code != 200:
            raise SatelliteHttpError(resp.status_code, resp.text)

        result = resp.json()
        return PushSuccess(hash=result["hash"], timestamp=result["timestamp"])
