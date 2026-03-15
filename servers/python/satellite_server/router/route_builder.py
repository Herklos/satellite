"""FastAPI router builder for the Satellite sync protocol."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Awaitable

import httpx

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from satellite_server.interfaces import IObjectStore
from satellite_server.config.schema import SyncConfig, CollectionConfig, SyncTrigger, WildcardRemoteConfig, WriteMode
from satellite_server.encryption.encrypted_store import EncryptedObjectStore
from satellite_server.protocol.pull import pull
from satellite_server.router.helpers import (
    handle_sync_pull,
    handle_sync_push,
    validate_path_segment,
    SignatureVerifier,
)
from satellite_server.router.middleware import check_body_limit, RateLimiter
from satellite_server.constants import (
    ROLE_PUBLIC,
    ROLE_SELF,
    OP_READ,
    OP_WRITE,
    ENCRYPTION_IDENTITY,
    ENCRYPTION_SERVER,
    ENCRYPTION_DELEGATED,
    ACTION_PULL,
    ACTION_PUSH,
    IDENTITY_PARAM,
    IDENTITY_KEY,
    QUERY_CHECKPOINT,
    HKDF_INFO_IDENTITY,
    HKDF_INFO_SERVER,
)

if TYPE_CHECKING:
    from satellite_server.replica.manager import ReplicaManager
    from satellite_server.replica.notifier import NotificationPublisher


@dataclass
class AuthResult:
    """Result of authenticating a request."""

    identity: str
    roles: list[str]


RoleResolver = Callable[[Request], Awaitable[AuthResult]]
RoleEnricher = Callable[[AuthResult, dict[str, str]], Awaitable[list[str]]]


@dataclass
class SyncRouterOptions:
    """Options for creating a sync router."""

    store: IObjectStore
    config: SyncConfig
    role_resolver: RoleResolver
    role_enricher: RoleEnricher | None = None
    encryption_secret: str | None = None
    server_encryption_secret: str | None = None
    server_identity: str | None = None
    identity_encryption_info: str | None = None
    server_encryption_info: str | None = None
    signature_verifier: SignatureVerifier | None = None
    replica_manager: ReplicaManager | None = None
    """Replica-side: enables ``on_pull`` sync trigger and ``write_through`` push proxying."""
    notification_publisher: NotificationPublisher | None = None
    """Primary-side: fan-out push notifications to subscribed replicas after each write."""


# ── Helpers ──────────────────────────────────────────────────────────────


def _to_route_path(action: str, storage_path: str) -> str:
    """Convert config storagePath template to a FastAPI route path.

    "users/{identity}/invoices" -> "/pull/users/{identity}/invoices"
    """
    return f"/{action}/{storage_path}"


def _resolve_document_key(template: str, params: dict[str, str]) -> str:
    """Resolve a storage path template into a document key."""
    result = template
    for key, value in params.items():
        result = result.replace(f"{{{key}}}", value)
    return result


def _validate_all_params(params: dict[str, str]) -> bool:
    for value in params.values():
        if not validate_path_segment(value):
            return False
    return True


def _extract_path_params(storage_path: str, request_path: str, action: str) -> dict[str, str]:
    """Extract path parameters from a request path using the storage path template."""
    param_names = re.findall(r"\{(\w+)\}", storage_path)
    pattern_str = storage_path
    for name in param_names:
        pattern_str = pattern_str.replace(f"{{{name}}}", f"(?P<{name}>[^/]+)")
    prefix = f"/{action}/"
    path_after_prefix = request_path[len(prefix):] if request_path.startswith(prefix) else request_path
    match = re.match(pattern_str, path_after_prefix)
    if not match:
        return {}
    return match.groupdict()


# ── Auth ─────────────────────────────────────────────────────────────────


async def _check_auth(
    col: CollectionConfig,
    operation: str,
    request: Request,
    params: dict[str, str],
    opts: SyncRouterOptions,
) -> tuple[str | None, JSONResponse | None]:
    """Check authorization. Returns (identity, error_response)."""
    required_roles = col.read_roles if operation == OP_READ else col.write_roles

    if ROLE_PUBLIC in required_roles:
        return None, None

    try:
        auth = await opts.role_resolver(request)
    except Exception:
        return None, JSONResponse({"error": "Unauthorized"}, status_code=401)

    effective_roles = set(auth.roles)

    # Auto-grant "self" when {identity} in path matches authenticated identity
    if IDENTITY_PARAM in col.storage_path:
        if params.get(IDENTITY_KEY) == auth.identity:
            effective_roles.add(ROLE_SELF)

    # Enrich roles
    if opts.role_enricher:
        extra = await opts.role_enricher(auth, params)
        effective_roles.update(extra)

    # Check access
    has_access = any(r in effective_roles for r in required_roles)
    if not has_access:
        return auth.identity, JSONResponse({"error": "Forbidden"}, status_code=403)

    return auth.identity, None


# ── Store resolution ─────────────────────────────────────────────────────


def _resolve_store(
    col: CollectionConfig,
    base_store: IObjectStore,
    params: dict[str, str],
    identity: str | None,
    opts: SyncRouterOptions,
) -> IObjectStore:
    if col.encryption == ENCRYPTION_IDENTITY:
        if not opts.encryption_secret:
            raise RuntimeError(f'Collection "{col.name}" requires encryption_secret')
        salt = identity or params.get(IDENTITY_KEY, "")
        return EncryptedObjectStore(
            base_store,
            opts.encryption_secret,
            salt,
            opts.identity_encryption_info or HKDF_INFO_IDENTITY,
        )
    if col.encryption == ENCRYPTION_SERVER:
        if not opts.server_encryption_secret:
            raise RuntimeError(f'Collection "{col.name}" requires server_encryption_secret')
        if not opts.server_identity:
            raise RuntimeError(f'Collection "{col.name}" requires server_identity')
        return EncryptedObjectStore(
            base_store,
            opts.server_encryption_secret,
            opts.server_identity,
            opts.server_encryption_info or HKDF_INFO_SERVER,
        )
    # ENCRYPTION_NONE and ENCRYPTION_DELEGATED: no server-side encryption.
    # Delegated encryption is handled entirely client-side.
    return base_store


# ── Write-through proxy ───────────────────────────────────────────────────


async def _proxy_push_to_primary(
    col: CollectionConfig,
    request: Request,
    replica_manager: ReplicaManager,
) -> JSONResponse:
    """Forward a push request to the primary satellite server (write_through mode).

    Returns the primary's response directly to the client, then triggers a
    background sync so the local store is updated with the primary's final state.
    """
    remote = col.remote  # type: ignore[union-attr]
    primary_url = f"{remote.url.rstrip('/')}{remote.push_path}"

    raw_body = await request.body()
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        **remote.headers,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(primary_url, content=raw_body, headers=headers)
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(
                {"error": f"Failed to reach primary: {exc}"},
                status_code=502,
            )

    # Mirror the primary's status code to the client
    if resp.status_code == 409:
        return JSONResponse({"error": "hash_mismatch"}, status_code=409)
    if not resp.is_success:
        return JSONResponse(
            {"error": f"Primary returned {resp.status_code}"},
            status_code=resp.status_code,
        )

    # Sync local store from primary in background
    asyncio.create_task(replica_manager.sync_now(col.name))

    return JSONResponse(resp.json(), status_code=resp.status_code)


# ── Route building ───────────────────────────────────────────────────────


def _add_collection_routes(
    router: APIRouter,
    col: CollectionConfig,
    opts: SyncRouterOptions,
) -> None:
    # Pull route
    if not col.push_only:
        pull_path = _to_route_path(ACTION_PULL, col.storage_path)

        async def pull_handler(request: Request, col=col) -> JSONResponse:
            params = request.path_params
            if not _validate_all_params(params):
                return JSONResponse({"error": "Invalid path parameter"}, status_code=400)

            identity, error = await _check_auth(col, OP_READ, request, params, opts)
            if error:
                return error

            # on_pull trigger: sync from primary before serving the local copy
            if (
                opts.replica_manager is not None
                and col.remote is not None
                and SyncTrigger.ON_PULL in col.remote.sync_triggers
            ):
                await opts.replica_manager.on_pull(col.name)

            document_key = _resolve_document_key(col.storage_path, params)
            store = _resolve_store(col, opts.store, params, identity, opts)
            checkpoint_param = request.query_params.get(QUERY_CHECKPOINT)
            is_client_encrypted = bool(col.client_encrypted) or col.encryption == ENCRYPTION_DELEGATED
            return await handle_sync_pull(
                document_key, store, checkpoint_param,
                bool(col.force_full_fetch), is_client_encrypted,
            )

        router.add_api_route(pull_path, pull_handler, methods=["GET"])

    # Push route
    if not col.pull_only:
        push_path = _to_route_path(ACTION_PUSH, col.storage_path)

        rate_limiter = None
        if col.rate_limit and opts.config.rate_limit:
            rate_limiter = RateLimiter(
                window_ms=opts.config.rate_limit.window_ms,
                max_requests=opts.config.rate_limit.max_requests,
            )

        async def push_handler(request: Request, col=col, rate_limiter=rate_limiter) -> JSONResponse:
            params = request.path_params
            if not _validate_all_params(params):
                return JSONResponse({"error": "Invalid path parameter"}, status_code=400)

            identity, error = await _check_auth(col, OP_WRITE, request, params, opts)
            if error:
                return error

            # write_through: block local writes and proxy to primary instead
            if (
                col.remote is not None
                and col.remote.write_mode == WriteMode.WRITE_THROUGH
                and opts.replica_manager is not None
            ):
                return await _proxy_push_to_primary(col, request, opts.replica_manager)

            # pull_only remote: reject local writes
            if col.remote is not None and col.remote.write_mode == WriteMode.PULL_ONLY:
                return JSONResponse(
                    {"error": "This collection is read-only on this server"},
                    status_code=405,
                )

            # Body limit
            content_length = request.headers.get("content-length")
            limit_error = check_body_limit(content_length, col.max_body_bytes)
            if limit_error:
                return limit_error

            # Rate limiting
            if rate_limiter:
                rate_error = rate_limiter.check(identity, request)
                if rate_error:
                    return rate_error

            # Content type check
            content_type = request.headers.get("content-type", "")
            if "application/json" not in content_type:
                return JSONResponse(
                    {"error": "Content-Type must be application/json"},
                    status_code=415,
                )

            body = await request.json()
            if not isinstance(body, dict):
                return JSONResponse({"error": "Body must be a JSON object"}, status_code=400)

            document_key = _resolve_document_key(col.storage_path, params)
            store = _resolve_store(col, opts.store, params, identity, opts)
            is_client_encrypted = bool(col.client_encrypted) or col.encryption == ENCRYPTION_DELEGATED
            response = await handle_sync_push(
                document_key, store, body, identity,
                opts.signature_verifier, is_client_encrypted,
            )

            # Primary-side: notify subscribed replicas after a successful write
            if opts.notification_publisher is not None and response.status_code == 200:
                import json as _json
                resp_body = _json.loads(response.body)
                new_hash = resp_body.get("hash", "")
                timestamp = resp_body.get("timestamp", 0)
                asyncio.create_task(
                    opts.notification_publisher.notify(col.name, new_hash, timestamp)
                )

            return response

        router.add_api_route(push_path, push_handler, methods=["POST"])


def _add_bundled_routes(
    router: APIRouter,
    bundle_name: str,
    collections: list[CollectionConfig],
    opts: SyncRouterOptions,
) -> None:
    storage_path = collections[0].storage_path

    # Pull: combined pull for all collections in the bundle
    pull_path = _to_route_path(ACTION_PULL, storage_path)
    is_any_public = any(ROLE_PUBLIC in c.read_roles for c in collections)

    async def bundle_pull_handler(request: Request) -> JSONResponse:
        params = request.path_params
        if not _validate_all_params(params):
            return JSONResponse({"error": "Invalid path parameter"}, status_code=400)

        if not is_any_public:
            identity, error = await _check_auth(collections[0], OP_READ, request, params, opts)
            if error:
                return error
        else:
            identity = None

        base_key = _resolve_document_key(storage_path, params)
        store = _resolve_store(collections[0], opts.store, params, identity, opts)

        any_client_encrypted = any(
            c.client_encrypted or c.encryption == ENCRYPTION_DELEGATED
            for c in collections
        )
        checkpoint_param = request.query_params.get(QUERY_CHECKPOINT)
        checkpoint = 0
        if not any_client_encrypted and checkpoint_param is not None:
            try:
                parsed = int(checkpoint_param)
            except ValueError:
                return JSONResponse({"error": "Invalid checkpoint"}, status_code=400)
            if parsed < 0 or str(parsed) != checkpoint_param:
                return JSONResponse({"error": "Invalid checkpoint"}, status_code=400)
            checkpoint = parsed

        result: dict[str, Any] = {}
        latest_timestamp = 0

        for col in collections:
            document_key = f"{base_key}/{col.name}"
            pull_result = await pull(store, document_key, checkpoint)
            result[col.name] = {
                "data": pull_result.data,
                "hash": pull_result.hash,
            }
            if pull_result.timestamp > latest_timestamp:
                latest_timestamp = pull_result.timestamp

        return JSONResponse({"collections": result, "timestamp": latest_timestamp})

    router.add_api_route(pull_path, bundle_pull_handler, methods=["GET"])

    # Push: individual push per collection in the bundle
    for col in collections:
        if col.pull_only:
            continue

        push_path = _to_route_path(ACTION_PUSH, storage_path) + f"/{col.name}"

        rate_limiter = None
        if col.rate_limit and opts.config.rate_limit:
            rate_limiter = RateLimiter(
                window_ms=opts.config.rate_limit.window_ms,
                max_requests=opts.config.rate_limit.max_requests,
            )

        async def bundle_push_handler(
            request: Request, col=col, rate_limiter=rate_limiter,
        ) -> JSONResponse:
            params = request.path_params
            if not _validate_all_params(params):
                return JSONResponse({"error": "Invalid path parameter"}, status_code=400)

            identity, error = await _check_auth(col, OP_WRITE, request, params, opts)
            if error:
                return error

            content_length = request.headers.get("content-length")
            limit_error = check_body_limit(content_length, col.max_body_bytes)
            if limit_error:
                return limit_error

            if rate_limiter:
                rate_error = rate_limiter.check(identity, request)
                if rate_error:
                    return rate_error

            content_type = request.headers.get("content-type", "")
            if "application/json" not in content_type:
                return JSONResponse(
                    {"error": "Content-Type must be application/json"},
                    status_code=415,
                )

            body = await request.json()
            if not isinstance(body, dict):
                return JSONResponse({"error": "Body must be a JSON object"}, status_code=400)

            document_key = f"{_resolve_document_key(storage_path, params)}/{col.name}"
            store = _resolve_store(col, opts.store, params, identity, opts)
            is_client_encrypted = bool(col.client_encrypted) or col.encryption == ENCRYPTION_DELEGATED
            return await handle_sync_push(
                document_key, store, body, identity,
                opts.signature_verifier, is_client_encrypted,
            )

        router.add_api_route(push_path, bundle_push_handler, methods=["POST"])


# ── Wildcard catch-all ────────────────────────────────────────────────────


def _add_wildcard_pull_route(router: APIRouter, opts: SyncRouterOptions) -> None:
    """Register a low-priority ``GET /pull/{path:path}`` route for wildcard replication.

    This route is added *after* all explicit collection routes so FastAPI will only
    invoke it for paths that did not match any configured collection.
    """
    wildcard: WildcardRemoteConfig = opts.config.wildcard_remote  # type: ignore[assignment]
    replica_manager = opts.replica_manager

    async def wildcard_pull_handler(request: Request) -> JSONResponse:
        path: str = request.path_params.get("path", "")

        # Validate every segment against the same safe-param regex used elsewhere
        if not path or any(not validate_path_segment(seg) for seg in path.split("/")):
            return JSONResponse({"error": "Invalid path"}, status_code=400)

        # Replica-side auth gate
        if ROLE_PUBLIC not in wildcard.read_roles:
            try:
                auth = await opts.role_resolver(request)
            except Exception:
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
            if not any(r in auth.roles for r in wildcard.read_roles):
                return JSONResponse({"error": "Forbidden"}, status_code=403)

        # Fetch from primary (or serve cached / negative-cached)
        if replica_manager is not None:
            found = await replica_manager.on_pull_wildcard(path)
            if not found:
                return JSONResponse({"error": "Not found"}, status_code=404)

        checkpoint_param = request.query_params.get(QUERY_CHECKPOINT)
        return await handle_sync_pull(
            path, opts.store, checkpoint_param,
            force_full_fetch=False, is_client_encrypted=False,
        )

    router.add_api_route("/pull/{path:path}", wildcard_pull_handler, methods=["GET"])


# ── Public API ───────────────────────────────────────────────────────────


def create_sync_router(opts: SyncRouterOptions) -> APIRouter:
    """Create a FastAPI APIRouter with sync pull/push routes."""
    router = APIRouter()
    config = opts.config

    # Group bundled collections
    bundles: dict[str, list[CollectionConfig]] = {}
    standalone: list[CollectionConfig] = []

    for col in config.collections:
        if col.bundle:
            bundles.setdefault(col.bundle, []).append(col)
        else:
            standalone.append(col)

    for col in standalone:
        _add_collection_routes(router, col, opts)

    for bundle_name, bundle_collections in bundles.items():
        _add_bundled_routes(router, bundle_name, bundle_collections, opts)

    # Wildcard catch-all must be registered last so explicit routes take priority
    if opts.config.wildcard_remote is not None and opts.replica_manager is not None:
        _add_wildcard_pull_route(router, opts)

    return router
