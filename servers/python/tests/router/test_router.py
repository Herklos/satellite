"""Tests for FastAPI sync router — ported from router.test.ts."""

import pytest
from fastapi import FastAPI, Request
from httpx import AsyncClient, ASGITransport

from satellite_server.config.schema import SyncConfig, CollectionConfig, RateLimitConfig
from satellite_server.router.route_builder import (
    create_sync_router,
    SyncRouterOptions,
    AuthResult,
)
from tests.helpers import MemoryObjectStore


def _build_app(
    identity: str = "user-1",
    roles: list[str] | None = None,
    rate_limit: RateLimitConfig | None = None,
) -> tuple[FastAPI, MemoryObjectStore]:
    store = MemoryObjectStore()
    config = SyncConfig(
        version=1,
        collections=[
            CollectionConfig(
                name="settings",
                storagePath="users/{identity}/settings",
                readRoles=["self"],
                writeRoles=["self"],
                encryption="none",
                maxBodyBytes=65536,
            ),
            CollectionConfig(
                name="public-config",
                storagePath="app/config",
                readRoles=["public"],
                writeRoles=["admin"],
                encryption="none",
                maxBodyBytes=65536,
            ),
        ],
        rateLimit=rate_limit,
    )

    async def role_resolver(request: Request) -> AuthResult:
        return AuthResult(identity=identity, roles=roles or [])

    router = create_sync_router(
        SyncRouterOptions(store=store, config=config, role_resolver=role_resolver),
    )
    app = FastAPI()
    app.include_router(router)
    return app, store


@pytest.mark.asyncio
async def test_pull_empty_collection():
    app, _ = _build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/pull/users/user-1/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["data"] == {}
    assert body["hash"] == ""


@pytest.mark.asyncio
async def test_push_then_pull_roundtrip():
    app, _ = _build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        push_resp = await client.post(
            "/push/users/user-1/settings",
            json={"data": {"theme": "dark"}, "baseHash": None},
            headers={"content-type": "application/json"},
        )
        assert push_resp.status_code == 200
        push_body = push_resp.json()
        assert len(push_body["hash"]) == 64

        pull_resp = await client.get("/pull/users/user-1/settings")
        assert pull_resp.status_code == 200
        pull_body = pull_resp.json()
        assert pull_body["data"] == {"theme": "dark"}
        assert pull_body["hash"] == push_body["hash"]


@pytest.mark.asyncio
async def test_self_role_denies_other_user():
    app, _ = _build_app(identity="user-1")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/pull/users/user-2/settings")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_public_collection_readable():
    app, _ = _build_app(identity="admin-user", roles=["admin"])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Push as admin
        await client.post(
            "/push/app/config",
            json={"data": {"version": "2.0"}, "baseHash": None},
            headers={"content-type": "application/json"},
        )
        # Pull publicly
        resp = await client.get("/pull/app/config")
    assert resp.status_code == 200
    assert resp.json()["data"] == {"version": "2.0"}


@pytest.mark.asyncio
async def test_non_admin_cannot_push_admin_collection():
    app, _ = _build_app(identity="regular-user", roles=[])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/push/app/config",
            json={"data": {"maintenance": True}, "baseHash": None},
            headers={"content-type": "application/json"},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_body_limit_enforced():
    app, _ = _build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/push/users/user-1/settings",
            json={"data": {"x": "a"}, "baseHash": None},
            headers={
                "content-type": "application/json",
                "content-length": "999999",
            },
        )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_conflict_on_stale_hash():
    app, _ = _build_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post(
            "/push/users/user-1/settings",
            json={"data": {"v": 1}, "baseHash": None},
            headers={"content-type": "application/json"},
        )
        resp = await client.post(
            "/push/users/user-1/settings",
            json={"data": {"v": 2}, "baseHash": "wrong-hash"},
            headers={"content-type": "application/json"},
        )
    assert resp.status_code == 409
    assert resp.json()["error"] == "hash_mismatch"


# ── Delegated encryption tests ───────────────────────────────────────────


def _build_delegated_app(
    identity: str = "user-1",
    roles: list[str] | None = None,
) -> tuple[FastAPI, MemoryObjectStore]:
    store = MemoryObjectStore()
    config = SyncConfig(
        version=1,
        collections=[
            CollectionConfig(
                name="vault",
                storagePath="users/{identity}/vault",
                readRoles=["self"],
                writeRoles=["self"],
                encryption="delegated",
                maxBodyBytes=65536,
            ),
        ],
    )

    async def role_resolver(request: Request) -> AuthResult:
        return AuthResult(identity=identity, roles=roles or [])

    router = create_sync_router(
        SyncRouterOptions(store=store, config=config, role_resolver=role_resolver),
    )
    app = FastAPI()
    app.include_router(router)
    return app, store


@pytest.mark.asyncio
async def test_delegated_encryption_requires_headers():
    app, _ = _build_delegated_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/pull/users/user-1/vault")
    assert resp.status_code == 400
    assert "X-Encryption-Secret" in resp.json()["error"]


@pytest.mark.asyncio
async def test_delegated_encryption_push_pull_roundtrip():
    app, _ = _build_delegated_app()
    headers = {
        "x-encryption-secret": "my-secret-key",
        "x-encryption-salt": "my-public-key-abc123",
        "content-type": "application/json",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        push_resp = await client.post(
            "/push/users/user-1/vault",
            json={"data": {"balance": 1000}, "baseHash": None},
            headers=headers,
        )
        assert push_resp.status_code == 200
        push_hash = push_resp.json()["hash"]

        pull_resp = await client.get(
            "/pull/users/user-1/vault",
            headers=headers,
        )
        assert pull_resp.status_code == 200
        assert pull_resp.json()["data"] == {"balance": 1000}
        assert pull_resp.json()["hash"] == push_hash


@pytest.mark.asyncio
async def test_delegated_encryption_different_credentials_cannot_decrypt():
    app, store = _build_delegated_app()
    headers_user = {
        "x-encryption-secret": "user-secret",
        "x-encryption-salt": "user-pubkey",
        "content-type": "application/json",
    }
    headers_other = {
        "x-encryption-secret": "other-secret",
        "x-encryption-salt": "other-pubkey",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post(
            "/push/users/user-1/vault",
            json={"data": {"secret": "value"}, "baseHash": None},
            headers=headers_user,
        )
        # Different credentials → decryption fails with InvalidTag
        with pytest.raises(Exception):
            await client.get(
                "/pull/users/user-1/vault",
                headers=headers_other,
            )


@pytest.mark.asyncio
async def test_delegated_encryption_admin_can_decrypt_with_shared_credentials():
    """Admin uses the same secret + salt the user shared with them."""
    app, _ = _build_delegated_app()
    shared_headers = {
        "x-encryption-secret": "shared-secret",
        "x-encryption-salt": "user-public-key",
        "content-type": "application/json",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # User pushes with their credentials
        await client.post(
            "/push/users/user-1/vault",
            json={"data": {"sensitive": "data"}, "baseHash": None},
            headers=shared_headers,
        )
        # Same credentials (shared with admin) can decrypt
        resp = await client.get(
            "/pull/users/user-1/vault",
            headers=shared_headers,
        )
    assert resp.status_code == 200
    assert resp.json()["data"] == {"sensitive": "data"}


@pytest.mark.asyncio
async def test_delegated_data_encrypted_at_rest():
    app, store = _build_delegated_app()
    headers = {
        "x-encryption-secret": "my-secret",
        "x-encryption-salt": "my-pubkey",
        "content-type": "application/json",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post(
            "/push/users/user-1/vault",
            json={"data": {"password": "hunter2"}, "baseHash": None},
            headers=headers,
        )
    # Check raw storage — data should be encrypted
    raw = await store.get_string("users/user-1/vault")
    assert raw is not None
    assert "hunter2" not in raw
    assert "password" not in raw
