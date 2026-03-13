"""Load and save sync configuration from/to object storage."""

from __future__ import annotations

import json

from satellite_server.interfaces import IObjectStore
from satellite_server.config.schema import SyncConfig
from satellite_server.config.validate import validate_config
from satellite_server.errors import StartupError
from satellite_server.constants import DEFAULT_CONFIG_KEY, CONTENT_TYPE_JSON


async def load_config(
    store: IObjectStore,
    config_key: str = DEFAULT_CONFIG_KEY,
) -> SyncConfig | None:
    """Load and validate a SyncConfig from storage.

    Returns None if no config exists at the given key.
    """
    raw = await store.get_string(config_key)
    if raw is None:
        return None

    parsed = SyncConfig.model_validate_json(raw)
    errors = validate_config(parsed)
    if errors:
        raise StartupError(f"Invalid sync config:\n" + "\n".join(errors))
    return parsed


async def save_config(
    store: IObjectStore,
    config: SyncConfig,
    config_key: str = DEFAULT_CONFIG_KEY,
) -> None:
    """Save a SyncConfig to storage. Validates before saving."""
    errors = validate_config(config)
    if errors:
        raise StartupError(f"Invalid sync config:\n" + "\n".join(errors))

    await store.put(
        config_key,
        config.model_dump_json(by_alias=True, indent=2),
        content_type=CONTENT_TYPE_JSON,
    )
