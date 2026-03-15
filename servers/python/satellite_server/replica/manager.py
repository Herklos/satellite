"""Replica manager — scheduled and on-demand sync from a remote primary satellite."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

import httpx

from satellite_server.config.schema import CollectionConfig, SyncTrigger, WildcardRemoteConfig, WriteMode
from satellite_server.interfaces import IObjectStore
from satellite_server.protocol.merge import deep_merge
from satellite_server.protocol.push import push
from satellite_server.protocol.types import PushSuccess

logger = logging.getLogger(__name__)



class ReplicaManager:
    """Manages replication from remote (primary) satellite servers.

    For each collection that has a ``remote`` field in its config, the
    ``ReplicaManager`` handles syncing data from the primary to local storage.
    Behaviour (write mode, sync triggers, interval) is fully driven by the
    collection config — no additional runtime configuration is needed.

    A single server can act as both primary and replica simultaneously.

    Typical usage::

        replica = ReplicaManager(store, config.collections,
                                 self_base_url="https://replica.example.com/v1")
        await replica.start()   # subscribe to primaries + begin scheduled tasks
        ...
        await replica.stop()    # clean shutdown

    The ``on_notification()`` and ``on_pull()`` methods are called by the
    replica router and pull route respectively.
    """

    def __init__(
        self,
        store: IObjectStore,
        collections: list[CollectionConfig],
        *,
        self_base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        on_error: Callable[[str, Exception], None] | None = None,
        wildcard_remote: WildcardRemoteConfig | None = None,
    ) -> None:
        self._store = store
        self._remote_cols = [c for c in collections if c.remote is not None]
        self._self_base_url = self_base_url
        self._owned_client = client is None
        self._client = client or httpx.AsyncClient(timeout=30.0)
        self._on_error = on_error or (
            lambda name, exc: logger.error("[ReplicaManager] %s: %s", name, exc)
        )
        self._wildcard_remote = wildcard_remote
        # In-memory last-known hash per collection (avoids redundant writes)
        self._last_hash: dict[str, str] = {}
        # Monotonic timestamp (seconds) of the last completed sync per collection
        self._last_sync_at: dict[str, float] = {}
        self._tasks: list[asyncio.Task[None]] = []
        # Wildcard state (keyed by collection path)
        self._wildcard_last_hash: dict[str, str] = {}
        self._wildcard_last_sync_at: dict[str, float] = {}
        self._negative_cache: dict[str, float] = {}  # path → monotonic time of 404/403

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Start background sync tasks and subscribe to primaries (webhook trigger).

        Calling ``start()`` multiple times is safe — any already-running tasks
        are left unchanged.
        """
        for col in self._remote_cols:
            remote = col.remote  # type: ignore[assignment]  # filtered above

            # Subscribe to primary so it notifies us on write
            if SyncTrigger.WEBHOOK in remote.sync_triggers and self._self_base_url:
                asyncio.create_task(self._subscribe(col))

            # Launch scheduled sync loop
            if SyncTrigger.SCHEDULED in remote.sync_triggers:
                task = asyncio.create_task(self._run_loop(col))
                self._tasks.append(task)
            else:
                # Even without a scheduled trigger, do one immediate sync on start
                asyncio.create_task(self._sync_safe(col))

    async def stop(self) -> None:
        """Cancel all background tasks and close the HTTP client (if owned)."""
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        if self._owned_client:
            await self._client.aclose()

    # ── Trigger entry points ──────────────────────────────────────────────────

    async def on_notification(self, collection_name: str) -> None:
        """Called by ``POST /replica/notify`` when the primary signals a write."""
        col = self._find(collection_name)
        if col is None:
            logger.warning("[ReplicaManager] Notification for unknown collection %r", collection_name)
            return
        await self._sync_safe(col)

    async def on_pull(self, collection_name: str) -> None:
        """Called by the pull route when ``on_pull`` is listed in ``sync_triggers``.

        Awaited before the local store is read, ensuring the response is fresh.
        If ``on_pull_min_interval_ms`` is configured and the last sync occurred within
        that window, the primary is not contacted and cached local data is served instead.
        """
        col = self._find(collection_name)
        if col is None:
            return

        min_interval_ms = col.remote.on_pull_min_interval_ms if col.remote else None  # type: ignore[union-attr]
        if min_interval_ms is not None:
            last = self._last_sync_at.get(collection_name)
            if last is not None and (time.monotonic() - last) * 1000 < min_interval_ms:
                return  # within cooldown — serve cached local data

        await self._sync_safe(col)

    async def sync_now(self, name: str) -> None:
        """Trigger an immediate sync for a single collection by name."""
        col = self._find(name)
        if col is None:
            raise ValueError(f"[ReplicaManager] Unknown remote collection: {name!r}")
        await self._do_sync(col)

    async def sync_all(self) -> None:
        """Trigger an immediate sync for all remote collections in parallel."""
        await asyncio.gather(*(self._sync_safe(col) for col in self._remote_cols))

    async def on_pull_wildcard(self, path: str) -> bool:
        """Called by the wildcard catch-all pull route for paths not matched by any explicit collection.

        Fetches from the primary on demand, stores the result locally, and returns
        ``True`` if data is available (freshly fetched or stale cached).  Returns
        ``False`` if the collection does not exist or is not authorised on the primary
        and no stale copy is held locally.

        Negative results (404 / 403 from primary) are cached for
        ``wildcard_remote.negative_cache_ms`` to avoid hammering the primary.
        On primary unavailability (network errors, 5xx) stale local data is served
        when available.
        """
        if self._wildcard_remote is None:
            return False

        wildcard = self._wildcard_remote

        # ── Negative cache ───────────────────────────────────────────────────
        neg_ts = self._negative_cache.get(path)
        if neg_ts is not None:
            if (time.monotonic() - neg_ts) * 1000 < wildcard.negative_cache_ms:
                # Still negatively cached — serve stale if available, else 404
                return await self._store.get_string(path) is not None
            # Cache expired — remove and retry
            del self._negative_cache[path]

        # ── on_pull cooldown ─────────────────────────────────────────────────
        if wildcard.on_pull_min_interval_ms is not None:
            last = self._wildcard_last_sync_at.get(path)
            if last is not None and (time.monotonic() - last) * 1000 < wildcard.on_pull_min_interval_ms:
                local = await self._store.get_string(path)
                if local is not None:
                    return True  # within cooldown, cached data available
                # No local data despite cooldown being active — fall through to fetch

        # ── Fetch from primary ───────────────────────────────────────────────
        pull_path = wildcard.pull_path_template.replace("{name}", path)
        primary_url = f"{wildcard.url.rstrip('/')}{pull_path}"

        try:
            resp = await self._client.get(
                primary_url,
                headers={"Accept": "application/json", **wildcard.headers},
            )
        except Exception as exc:
            logger.warning("[ReplicaManager] Wildcard fetch failed for %r: %s", path, exc)
            return await self._store.get_string(path) is not None  # serve stale

        if resp.status_code in (401, 403, 404):
            self._negative_cache[path] = time.monotonic()
            logger.debug(
                "[ReplicaManager] Wildcard %r: primary returned HTTP %s — negative-cached",
                path,
                resp.status_code,
            )
            return await self._store.get_string(path) is not None  # serve stale if any

        if not resp.is_success:
            logger.warning(
                "[ReplicaManager] Wildcard fetch for %r returned HTTP %s — serving stale",
                path,
                resp.status_code,
            )
            return await self._store.get_string(path) is not None  # serve stale

        import json

        pulled: dict[str, Any] = resp.json()
        primary_hash: str = pulled.get("hash", "")
        primary_data: dict[str, Any] = pulled.get("data", {})

        if not primary_hash:
            # Empty collection on primary
            return False

        # Skip write if we already have this version
        if self._wildcard_last_hash.get(path) != primary_hash:
            raw_local = await self._store.get_string(path)
            current_hash: str | None = None
            if raw_local:
                current_hash = json.loads(raw_local).get("hash") or None

            if current_hash != primary_hash:
                result = await push(self._store, path, primary_data, current_hash)
                if isinstance(result, PushSuccess):
                    self._wildcard_last_hash[path] = result.hash
            else:
                self._wildcard_last_hash[path] = primary_hash

        self._wildcard_last_sync_at[path] = time.monotonic()
        logger.debug("[ReplicaManager] Wildcard synced %r (hash=%s)", path, primary_hash)
        return True

    # ── Internal ─────────────────────────────────────────────────────────────

    def _find(self, name: str) -> CollectionConfig | None:
        return next((c for c in self._remote_cols if c.name == name), None)

    async def _run_loop(self, col: CollectionConfig) -> None:
        interval = col.remote.interval_ms / 1000  # type: ignore[union-attr]
        while True:
            await self._sync_safe(col)
            await asyncio.sleep(interval)

    async def _sync_safe(self, col: CollectionConfig) -> None:
        try:
            await self._do_sync(col)
        except Exception as exc:  # noqa: BLE001
            self._on_error(col.name, exc)

    async def _do_sync(self, col: CollectionConfig) -> None:
        remote = col.remote  # type: ignore[assignment]
        document_key = col.storage_path  # static path — validated at config load time

        # Full pull from primary (no checkpoint — always get the authoritative full document)
        primary_url = f"{remote.url.rstrip('/')}{remote.pull_path}"
        resp = await self._client.get(
            primary_url,
            headers={"Accept": "application/json", **remote.headers},
        )
        resp.raise_for_status()
        pulled: dict[str, Any] = resp.json()

        primary_hash: str = pulled.get("hash", "")
        primary_data: dict[str, Any] = pulled.get("data", {})

        # Nothing on primary yet
        if not primary_hash:
            return

        # Skip write if primary hasn't changed since our last sync
        if self._last_hash.get(col.name) == primary_hash:
            return

        # Read the current local document to get its hash
        raw_local = await self._store.get_string(document_key)
        current_local_hash: str = ""
        current_local_data: dict[str, Any] = {}
        if raw_local:
            import json
            local_doc = json.loads(raw_local)
            current_local_hash = local_doc.get("hash", "")
            current_local_data = local_doc.get("data", {})

        # Local store already matches primary — just update in-memory state
        if current_local_hash == primary_hash:
            self._last_hash[col.name] = primary_hash
            return

        # Determine data to write based on write mode
        if remote.write_mode == WriteMode.BIDIRECTIONAL and current_local_data:
            data_to_write = deep_merge(current_local_data, primary_data)
        else:
            # PULL_ONLY and WRITE_THROUGH: mirror primary exactly
            data_to_write = primary_data

        # Write to local store using the push protocol
        # base_hash=None → first write (doc doesn't exist); otherwise use current local hash
        base_hash = current_local_hash if current_local_hash else None
        result = await push(self._store, document_key, data_to_write, base_hash)

        if not isinstance(result, PushSuccess):
            # Concurrent write between our read and write — self-corrects on next sync
            raise RuntimeError(
                f"[ReplicaManager] Concurrent write on {col.name!r} — will retry"
            )

        self._last_hash[col.name] = result.hash
        self._last_sync_at[col.name] = time.monotonic()
        logger.debug("[ReplicaManager] Synced %r (hash=%s)", col.name, result.hash)

    async def _subscribe(self, col: CollectionConfig) -> None:
        """Register this replica's webhook URL with the primary."""
        remote = col.remote  # type: ignore[assignment]
        webhook_url = self._self_base_url
        subscribe_url = f"{remote.url.rstrip('/')}/replica/subscribe"
        try:
            resp = await self._client.post(
                subscribe_url,
                json={"webhook_url": webhook_url, "collections": [col.name]},
                headers={"Content-Type": "application/json", **remote.headers},
            )
            if not resp.is_success:
                logger.warning(
                    "[ReplicaManager] Subscription to %s returned HTTP %s",
                    subscribe_url,
                    resp.status_code,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[ReplicaManager] Could not subscribe to %s: %s (scheduled pulls will still work)",
                subscribe_url,
                exc,
            )
