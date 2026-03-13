"""Tests for config schema, validation, and loader — ported from config.test.ts."""

import pytest
from pydantic import ValidationError

from satellite_server.config.schema import SyncConfig, CollectionConfig
from satellite_server.config.validate import validate_config
from satellite_server.config.loader import load_config, save_config
from tests.helpers import MemoryObjectStore

VALID_CONFIG = SyncConfig(
    version=1,
    collections=[
        CollectionConfig(
            name="signals",
            storagePath="products/{productId}/signals",
            readRoles=["public"],
            writeRoles=["owner"],
            encryption="none",
            maxBodyBytes=65536,
        ),
        CollectionConfig(
            name="settings",
            storagePath="users/{identity}/settings",
            readRoles=["self", "admin"],
            writeRoles=["self"],
            encryption="identity",
            maxBodyBytes=131072,
        ),
    ],
)


class TestSyncConfigSchema:
    def test_parses_valid_config(self):
        assert VALID_CONFIG.version == 1
        assert len(VALID_CONFIG.collections) == 2

    def test_rejects_invalid_version(self):
        with pytest.raises(ValidationError):
            SyncConfig(
                version=2,  # type: ignore[arg-type]
                collections=[],
            )

    def test_rejects_empty_collection_name(self):
        with pytest.raises(ValidationError):
            CollectionConfig(
                name="",
                storagePath="x",
                readRoles=["public"],
                writeRoles=["admin"],
                encryption="none",
                maxBodyBytes=1024,
            )


class TestValidateConfig:
    def test_returns_no_errors_for_valid_config(self):
        assert validate_config(VALID_CONFIG) == []

    def test_detects_duplicate_collection_names(self):
        dupe = SyncConfig(
            version=1,
            collections=[
                CollectionConfig(
                    name="a", storagePath="x", readRoles=["public"],
                    writeRoles=["admin"], encryption="none", maxBodyBytes=1024,
                ),
                CollectionConfig(
                    name="a", storagePath="y", readRoles=["public"],
                    writeRoles=["admin"], encryption="none", maxBodyBytes=1024,
                ),
            ],
        )
        errors = validate_config(dupe)
        assert any("Duplicate" in e for e in errors)

    def test_detects_pull_only_push_only_conflict(self):
        bad = SyncConfig(
            version=1,
            collections=[
                CollectionConfig(
                    name="a", storagePath="x", readRoles=["public"],
                    writeRoles=["admin"], encryption="none", maxBodyBytes=1024,
                    pullOnly=True, pushOnly=True,
                ),
            ],
        )
        errors = validate_config(bad)
        assert any("pullOnly" in e for e in errors)


class TestLoadSaveConfig:
    @pytest.mark.asyncio
    async def test_round_trips_config_through_storage(self):
        store = MemoryObjectStore()
        await save_config(store, VALID_CONFIG)

        loaded = await load_config(store)
        assert loaded is not None
        assert loaded.version == VALID_CONFIG.version
        assert len(loaded.collections) == len(VALID_CONFIG.collections)
        for loaded_col, orig_col in zip(loaded.collections, VALID_CONFIG.collections):
            assert loaded_col.name == orig_col.name
            assert loaded_col.storage_path == orig_col.storage_path
            assert loaded_col.encryption == orig_col.encryption

    @pytest.mark.asyncio
    async def test_returns_none_when_no_config_exists(self):
        store = MemoryObjectStore()
        loaded = await load_config(store)
        assert loaded is None
