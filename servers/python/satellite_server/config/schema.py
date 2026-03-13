"""Pydantic models for sync configuration."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from satellite_server.constants import ENCRYPTION_NONE, ENCRYPTION_IDENTITY, ENCRYPTION_SERVER

EncryptionMode = Literal["none", "identity", "server"]


class CollectionConfig(BaseModel):
    """Configuration for a single synced collection."""

    model_config = {"populate_by_name": True}

    name: str = Field(min_length=1)
    storage_path: str = Field(min_length=1, alias="storagePath")
    read_roles: list[str] = Field(alias="readRoles")
    write_roles: list[str] = Field(alias="writeRoles")
    encryption: EncryptionMode
    max_body_bytes: int = Field(gt=0, alias="maxBodyBytes")
    rate_limit: bool | None = Field(default=None, alias="rateLimit")
    pull_only: bool | None = Field(default=None, alias="pullOnly")
    push_only: bool | None = Field(default=None, alias="pushOnly")
    force_full_fetch: bool | None = Field(default=None, alias="forceFullFetch")
    client_encrypted: bool | None = Field(default=None, alias="clientEncrypted")
    bundle: str | None = Field(default=None, min_length=1)


class RateLimitConfig(BaseModel):
    """Rate limiting configuration."""

    model_config = {"populate_by_name": True}

    window_ms: int = Field(gt=0, alias="windowMs")
    max_requests: int = Field(gt=0, alias="maxRequests")


class SyncConfig(BaseModel):
    """Top-level sync configuration."""

    model_config = {"populate_by_name": True}

    version: Literal[1]
    collections: list[CollectionConfig]
    rate_limit: RateLimitConfig | None = Field(default=None, alias="rateLimit")
