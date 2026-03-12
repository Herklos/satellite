use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// Response from a pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullResponse {
    pub data: HashMap<String, serde_json::Value>,
    pub hash: String,
    pub timestamp: u64,
    #[serde(rename = "authorPubkey", skip_serializing_if = "Option::is_none")]
    pub author_pubkey: Option<String>,
    #[serde(rename = "authorSignature", skip_serializing_if = "Option::is_none")]
    pub author_signature: Option<String>,
}

/// Response from a successful push.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSuccess {
    pub hash: String,
    pub timestamp: u64,
}

/// Push request body.
#[derive(Debug, Serialize)]
pub struct PushRequest {
    pub data: HashMap<String, serde_json::Value>,
    #[serde(rename = "baseHash")]
    pub base_hash: Option<String>,
    #[serde(rename = "authorSignature", skip_serializing_if = "Option::is_none")]
    pub author_signature: Option<String>,
}

/// Errors from the Satellite SDK.
#[derive(Debug, Error)]
pub enum SatelliteError {
    #[error("hash_mismatch")]
    Conflict,

    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },

    #[error("request failed: {0}")]
    Request(String),

    #[error("encryption error: {0}")]
    Encryption(String),

    #[error("storage error: {0}")]
    Storage(String),
}

/// Auth provider trait: returns headers to include in requests.
#[async_trait::async_trait(?Send)]
pub trait AuthProvider {
    async fn headers(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<HashMap<String, String>, SatelliteError>;
}

/// Conflict resolver: given local and remote data, return merged result.
pub type ConflictResolver =
    Box<dyn Fn(&serde_json::Value, &serde_json::Value) -> serde_json::Value>;

/// Data signer for author provenance.
#[async_trait::async_trait(?Send)]
pub trait DataSigner {
    async fn sign(&self, data: &str) -> Result<String, SatelliteError>;
}
