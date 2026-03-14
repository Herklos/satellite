"""Tests for ReplicaManager.on_pull_wildcard — wildcard on-demand pull."""

from __future__ import annotations

import json
import time

import httpx
import pytest
import respx

from satellite_server.config.schema import WildcardRemoteConfig
from satellite_server.protocol.push import push
from satellite_server.replica.manager import ReplicaManager
from tests.helpers import MemoryObjectStore


def _wildcard(
    negative_cache_ms: int = 300_000,
    on_pull_min_interval_ms: int | None = None,
) -> WildcardRemoteConfig:
    return WildcardRemoteConfig(
        url="https://primary.example.com/v1",
        pull_path_template="/pull/{name}",
        read_roles=["public"],
        negative_cache_ms=negative_cache_ms,
        on_pull_min_interval_ms=on_pull_min_interval_ms,
    )


def _primary_response(data: dict, hash_val: str = "abc123", timestamp: int = 1000) -> dict:
    return {"data": data, "hash": hash_val, "timestamp": timestamp}


# ── Basic fetch ───────────────────────────────────────────────────────────


@respx.mock
async def test_wildcard_fetches_from_primary_and_stores_locally():
    store = MemoryObjectStore()
    respx.get("https://primary.example.com/v1/pull/posts/trending").respond(
        200, json=_primary_response({"title": "Trending"}, hash_val="h1")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found = await manager.on_pull_wildcard("posts/trending")

    assert found is True
    raw = await store.get_string("posts/trending")
    assert raw is not None
    assert json.loads(raw)["data"] == {"title": "Trending"}


@respx.mock
async def test_wildcard_path_template_substituted_correctly():
    store = MemoryObjectStore()
    route = respx.get("https://primary.example.com/v1/pull/a/b/c").respond(
        200, json=_primary_response({"x": 1}, hash_val="h2")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        await manager.on_pull_wildcard("a/b/c")

    assert route.call_count == 1


@respx.mock
async def test_wildcard_empty_primary_returns_false():
    store = MemoryObjectStore()
    respx.get("https://primary.example.com/v1/pull/empty/col").respond(
        200, json={"data": {}, "hash": "", "timestamp": 0}
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found = await manager.on_pull_wildcard("empty/col")

    assert found is False
    assert await store.get_string("empty/col") is None


# ── Negative caching ──────────────────────────────────────────────────────


@respx.mock
@pytest.mark.parametrize("status_code", [404, 403, 401])
async def test_wildcard_negative_cached_on_primary_rejection(status_code: int):
    store = MemoryObjectStore()
    route = respx.get("https://primary.example.com/v1/pull/secret/col").respond(status_code)

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found1 = await manager.on_pull_wildcard("secret/col")  # hits primary
        found2 = await manager.on_pull_wildcard("secret/col")  # negative-cached

    assert found1 is False
    assert found2 is False
    assert route.call_count == 1  # primary contacted only once


@respx.mock
async def test_wildcard_serves_stale_when_negatively_cached_but_has_local_data():
    """If data exists locally but the primary subsequently returns 403, serve stale."""
    store = MemoryObjectStore()
    # Pre-populate local store with previous fetch
    await push(store, "archive/old", {"content": "stale"}, None)

    respx.get("https://primary.example.com/v1/pull/archive/old").respond(403)

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found = await manager.on_pull_wildcard("archive/old")

    # Should return True (stale data) rather than 404
    assert found is True
    raw = await store.get_string("archive/old")
    assert json.loads(raw)["data"] == {"content": "stale"}


@respx.mock
async def test_wildcard_negative_cache_expires_and_retries():
    """After negative_cache_ms elapses, the next call hits the primary again."""
    store = MemoryObjectStore()
    route = respx.get("https://primary.example.com/v1/pull/posts/new").respond(
        200, json=_primary_response({"v": 1}, hash_val="h3")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(
            store, [], client=client, wildcard_remote=_wildcard(negative_cache_ms=1)
        )
        # First call — primary returns 200 (no negative cache applied, just hash cache)
        await manager.on_pull_wildcard("posts/new")

    # Simulate a 404 to put path in negative cache
    route.respond(404)
    async with httpx.AsyncClient() as client:
        manager2 = ReplicaManager(
            store, [], client=client, wildcard_remote=_wildcard(negative_cache_ms=1)
        )
        await manager2.on_pull_wildcard("posts/new")  # negative-cached now
        # Force expiry
        manager2._negative_cache["posts/new"] = time.monotonic() - 1.0
        route.respond(200, json=_primary_response({"v": 2}, hash_val="h4"))
        found = await manager2.on_pull_wildcard("posts/new")  # cache expired — retry

    assert found is True
    assert json.loads(await store.get_string("posts/new"))["data"] == {"v": 2}


# ── Stale-on-error ────────────────────────────────────────────────────────


@respx.mock
async def test_wildcard_serves_stale_on_primary_5xx():
    store = MemoryObjectStore()
    await push(store, "feed/main", {"items": [1, 2, 3]}, None)

    respx.get("https://primary.example.com/v1/pull/feed/main").respond(503)

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found = await manager.on_pull_wildcard("feed/main")

    assert found is True  # stale served


@respx.mock
async def test_wildcard_returns_false_on_primary_5xx_with_no_local_data():
    store = MemoryObjectStore()
    respx.get("https://primary.example.com/v1/pull/missing/col").respond(503)

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found = await manager.on_pull_wildcard("missing/col")

    assert found is False


@respx.mock
async def test_wildcard_serves_stale_on_network_error():
    store = MemoryObjectStore()
    await push(store, "cached/doc", {"z": 99}, None)

    respx.get("https://primary.example.com/v1/pull/cached/doc").mock(
        side_effect=httpx.ConnectError("unreachable")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        found = await manager.on_pull_wildcard("cached/doc")

    assert found is True


# ── on_pull cooldown ──────────────────────────────────────────────────────


@respx.mock
async def test_wildcard_respects_on_pull_cooldown():
    store = MemoryObjectStore()
    route = respx.get("https://primary.example.com/v1/pull/cool/col").respond(
        200, json=_primary_response({"a": 1}, hash_val="h5")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(
            store, [], client=client,
            wildcard_remote=_wildcard(on_pull_min_interval_ms=5_000),
        )
        await manager.on_pull_wildcard("cool/col")   # first — hits primary
        found = await manager.on_pull_wildcard("cool/col")  # within cooldown

    assert found is True
    assert route.call_count == 1  # primary hit only once


@respx.mock
async def test_wildcard_syncs_after_cooldown_expires():
    store = MemoryObjectStore()
    route = respx.get("https://primary.example.com/v1/pull/cool/col").respond(
        200, json=_primary_response({"a": 1}, hash_val="h6")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(
            store, [], client=client,
            wildcard_remote=_wildcard(on_pull_min_interval_ms=1),
        )
        await manager.on_pull_wildcard("cool/col")
        manager._wildcard_last_sync_at["cool/col"] = time.monotonic() - 1.0  # expire cooldown
        await manager.on_pull_wildcard("cool/col")

    assert route.call_count == 2


# ── Hash deduplication ────────────────────────────────────────────────────


@respx.mock
async def test_wildcard_skips_write_when_hash_unchanged():
    store = MemoryObjectStore()
    respx.get("https://primary.example.com/v1/pull/dedup/col").respond(
        200, json=_primary_response({"v": 1}, hash_val="same-hash")
    )

    async with httpx.AsyncClient() as client:
        manager = ReplicaManager(store, [], client=client, wildcard_remote=_wildcard())
        await manager.on_pull_wildcard("dedup/col")  # stores data
        initial_raw = await store.get_string("dedup/col")

        # Simulate second fetch: same hash already known
        manager._wildcard_last_hash["dedup/col"] = "same-hash"
        await manager.on_pull_wildcard("dedup/col")  # should skip write

    assert await store.get_string("dedup/col") == initial_raw
