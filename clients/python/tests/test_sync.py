"""Tests for SyncManager."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from satellite_sdk.client import SatelliteClient
from satellite_sdk.sync import SyncManager
from satellite_sdk.types import PullResponse, PushSuccess


def mock_client(
    pull_responses: list[PullResponse] | None = None,
    push_responses: list[PushSuccess] | None = None,
) -> SatelliteClient:
    client = SatelliteClient.__new__(SatelliteClient)
    pull_data = pull_responses or [
        PullResponse(data={"key": "value"}, hash="abc123", timestamp=1000)
    ]
    push_data = push_responses or [
        PushSuccess(hash="def456", timestamp=2000)
    ]
    client.pull = AsyncMock(side_effect=pull_data)  # type: ignore
    client.push = AsyncMock(side_effect=push_data)  # type: ignore
    return client


@pytest.mark.asyncio
async def test_pull_stores_state():
    client = mock_client()
    sync = SyncManager(client, "/pull/test", "/push/test")

    result = await sync.pull()
    assert result.data == {"key": "value"}
    assert sync.data == {"key": "value"}
    assert sync.hash == "abc123"
    assert sync.checkpoint == 1000


@pytest.mark.asyncio
async def test_push_sends_data():
    client = mock_client()
    sync = SyncManager(client, "/pull/test", "/push/test")

    result = await sync.push({"newKey": "newValue"})
    assert result["hash"] == "def456"
    assert result["timestamp"] == 2000
    assert sync.hash == "def456"
    client.push.assert_called_once_with(  # type: ignore
        "/push/test", {"newKey": "newValue"}, None, None
    )


@pytest.mark.asyncio
async def test_incremental_pull_merges():
    client = mock_client(
        pull_responses=[
            PullResponse(data={"a": 1, "b": 2}, hash="h1", timestamp=100),
            PullResponse(data={"b": 3}, hash="h2", timestamp=200),
        ]
    )
    sync = SyncManager(client, "/pull/test", "/push/test")

    await sync.pull()  # full pull
    assert sync.data == {"a": 1, "b": 2}

    await sync.pull()  # incremental — merges
    assert sync.data == {"a": 1, "b": 3}
