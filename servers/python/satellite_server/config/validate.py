"""Semantic validation beyond what Pydantic covers."""

from __future__ import annotations

from satellite_server.config.schema import SyncConfig
from satellite_server.constants import ENCRYPTION_IDENTITY, IDENTITY_PARAM, ROLE_PUBLIC


def validate_config(config: SyncConfig) -> list[str]:
    """Validate config semantics. Returns error messages (empty = valid)."""
    errors: list[str] = []
    names: set[str] = set()

    for col in config.collections:
        # Duplicate names
        if col.name in names:
            errors.append(f'Duplicate collection name: "{col.name}"')
        names.add(col.name)

        # storagePath must not start with /
        if col.storage_path.startswith("/"):
            errors.append(f'Collection "{col.name}": storagePath must not start with /')

        # pullOnly + pushOnly conflict
        if col.pull_only and col.push_only:
            errors.append(f'Collection "{col.name}": cannot be both pullOnly and pushOnly')

        # Public collections must not use identity-based encryption
        if ROLE_PUBLIC in col.read_roles and col.encryption == ENCRYPTION_IDENTITY:
            errors.append(
                f'Collection "{col.name}": public collections must not use '
                f'"{ENCRYPTION_IDENTITY}" encryption (key would be derived from empty identity)'
            )

        # Bundled collections must use identity encryption
        if col.bundle and col.encryption != ENCRYPTION_IDENTITY:
            errors.append(
                f'Collection "{col.name}": bundled collections must use "{ENCRYPTION_IDENTITY}" encryption'
            )

        # Bundled collections must have {identity} in storagePath
        if col.bundle and IDENTITY_PARAM not in col.storage_path:
            errors.append(
                f'Collection "{col.name}": bundled collections must have {IDENTITY_PARAM} in storagePath'
            )

        # readRoles should not be empty (unless pullOnly)
        if not col.pull_only and not col.read_roles:
            errors.append(
                f'Collection "{col.name}": readRoles must not be empty (use ["{ROLE_PUBLIC}"] for public access)'
            )

    # Check bundles: all collections in same bundle must share storagePath
    bundles: dict[str, str] = {}
    for col in config.collections:
        if not col.bundle:
            continue
        existing = bundles.get(col.bundle)
        if existing and existing != col.storage_path:
            errors.append(
                f'Bundle "{col.bundle}": all collections must share the same storagePath '
                f'(found "{existing}" and "{col.storage_path}")'
            )
        bundles[col.bundle] = col.storage_path

    return errors
