"""Satellite sync protocol server."""

from satellite_server.interfaces import IObjectStore
from satellite_server.errors import StartupError, AuthError, ConflictError, NotFoundError
from satellite_server.constants import (
    ROLE_PUBLIC,
    ROLE_SELF,
    OP_READ,
    OP_WRITE,
    ENCRYPTION_NONE,
    ENCRYPTION_IDENTITY,
    ENCRYPTION_SERVER,
    ENCRYPTION_DELEGATED,
    ACTION_PULL,
    ACTION_PUSH,
    IDENTITY_PARAM,
    IDENTITY_KEY,
    QUERY_CHECKPOINT,
    HKDF_INFO_DEFAULT,
    HKDF_INFO_IDENTITY,
    HKDF_INFO_SERVER,
    DEFAULT_CONFIG_KEY,
    ERROR_HASH_MISMATCH,
    CONTENT_TYPE_JSON,
)
from satellite_server.timestamp import next_timestamp
from satellite_server.protocol.hash import stable_stringify, compute_hash
from satellite_server.protocol.types import StoredDocument, PullResult, PushResult, Timestamps
from satellite_server.protocol.timestamps import compute_timestamps, filter_by_checkpoint
from satellite_server.protocol.pull import pull
from satellite_server.protocol.push import push
from satellite_server.protocol.merge import deep_merge
from satellite_server.encryption.encrypted_store import EncryptedObjectStore
from satellite_server.config.schema import (
    SyncConfig,
    CollectionConfig,
    RateLimitConfig,
    EncryptionMode,
    RemoteConfig,
    WildcardRemoteConfig,
    WriteMode,
    SyncTrigger,
)
from satellite_server.config.validate import validate_config
from satellite_server.config.loader import load_config, save_config, parse_config_json, load_config_file
from satellite_server.replica import (
    ReplicaManager,
    NotificationPublisher,
    Subscription,
    SubscriptionStore,
    create_replica_router,
)
from satellite_server.storage.filesystem import FilesystemObjectStore, FilesystemStorageOptions

__all__ = [
    "IObjectStore",
    "StartupError",
    "AuthError",
    "ConflictError",
    "NotFoundError",
    "ROLE_PUBLIC",
    "ROLE_SELF",
    "OP_READ",
    "OP_WRITE",
    "ENCRYPTION_NONE",
    "ENCRYPTION_IDENTITY",
    "ENCRYPTION_SERVER",
    "ENCRYPTION_DELEGATED",
    "ACTION_PULL",
    "ACTION_PUSH",
    "IDENTITY_PARAM",
    "IDENTITY_KEY",
    "QUERY_CHECKPOINT",
    "HKDF_INFO_DEFAULT",
    "HKDF_INFO_IDENTITY",
    "HKDF_INFO_SERVER",
    "DEFAULT_CONFIG_KEY",
    "ERROR_HASH_MISMATCH",
    "CONTENT_TYPE_JSON",
    "next_timestamp",
    "stable_stringify",
    "compute_hash",
    "StoredDocument",
    "PullResult",
    "PushResult",
    "Timestamps",
    "compute_timestamps",
    "filter_by_checkpoint",
    "pull",
    "push",
    "EncryptedObjectStore",
    "SyncConfig",
    "CollectionConfig",
    "RateLimitConfig",
    "EncryptionMode",
    "RemoteConfig",
    "WildcardRemoteConfig",
    "WriteMode",
    "SyncTrigger",
    "validate_config",
    "load_config",
    "save_config",
    "parse_config_json",
    "load_config_file",
    "ReplicaManager",
    "NotificationPublisher",
    "Subscription",
    "SubscriptionStore",
    "create_replica_router",
    "FilesystemObjectStore",
    "FilesystemStorageOptions",
]
