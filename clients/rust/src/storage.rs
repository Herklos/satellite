use crate::types::SatelliteError;

/// Async key-value storage for SyncManager persistence.
///
/// Implement this trait to persist sync state across restarts.
/// The SyncManager stores three keys: `"lastHash"`, `"lastCheckpoint"`, and `"localData"`.
///
/// Scoping (e.g., by namespace or path) is the implementer's responsibility.
#[async_trait::async_trait(?Send)]
pub trait StorageProvider {
    async fn get(&self, key: &str) -> Result<Option<String>, SatelliteError>;
    async fn set(&self, key: &str, value: &str) -> Result<(), SatelliteError>;
    async fn delete(&self, key: &str) -> Result<(), SatelliteError>;
}
