use std::collections::HashMap;

use serde_json::Value;

use crate::client::SatelliteClient;
use crate::crypto::Encryptor;
use crate::hash::stable_stringify;
use crate::types::{DataSigner, PullResponse, SatelliteError};

/// Default deep-merge: remote wins on leaf conflicts.
fn default_merge(local: &Value, remote: &Value) -> Value {
    match (local, remote) {
        (Value::Object(l), Value::Object(r)) => {
            let mut merged = l.clone();
            for (key, remote_val) in r {
                let entry = merged
                    .entry(key.clone())
                    .or_insert(Value::Null);
                if entry.is_object() && remote_val.is_object() {
                    *entry = default_merge(entry, remote_val);
                } else {
                    *entry = remote_val.clone();
                }
            }
            Value::Object(merged)
        }
        _ => remote.clone(),
    }
}

/// Deep assign source into target.
fn deep_assign(target: &mut Value, source: &Value) {
    if let (Value::Object(t), Value::Object(s)) = (target, source) {
        for (key, src_val) in s {
            let entry = t.entry(key.clone()).or_insert(Value::Null);
            if entry.is_object() && src_val.is_object() {
                deep_assign(entry, src_val);
            } else {
                *entry = src_val.clone();
            }
        }
    }
}

/// High-level sync manager with pull, push, and automatic conflict resolution.
pub struct SyncManager {
    client: SatelliteClient,
    pull_path: String,
    push_path: String,
    merge: Box<dyn Fn(&Value, &Value) -> Value>,
    max_retries: u32,
    encryptor: Option<Encryptor>,
    signer: Option<Box<dyn DataSigner>>,

    last_hash: Option<String>,
    last_checkpoint: u64,
    local_data: HashMap<String, Value>,
}

/// Options for creating a SyncManager.
pub struct SyncManagerOptions {
    pub client: SatelliteClient,
    pub pull_path: String,
    pub push_path: String,
    pub on_conflict: Option<Box<dyn Fn(&Value, &Value) -> Value>>,
    pub max_retries: Option<u32>,
    pub encryption_secret: Option<String>,
    pub encryption_salt: Option<String>,
    pub encryption_info: Option<String>,
    pub sign_data: Option<Box<dyn DataSigner>>,
}

impl SyncManager {
    pub fn new(opts: SyncManagerOptions) -> Result<Self, SatelliteError> {
        let encryptor = match (&opts.encryption_secret, &opts.encryption_salt) {
            (Some(secret), Some(salt)) => Some(Encryptor::new(
                secret,
                salt,
                opts.encryption_info.as_deref(),
            )?),
            _ => None,
        };

        Ok(Self {
            client: opts.client,
            pull_path: opts.pull_path,
            push_path: opts.push_path,
            merge: opts.on_conflict.unwrap_or_else(|| Box::new(default_merge)),
            max_retries: opts.max_retries.unwrap_or(3),
            encryptor,
            signer: opts.sign_data,
            last_hash: None,
            last_checkpoint: 0,
            local_data: HashMap::new(),
        })
    }

    /// Get the current local data snapshot.
    pub fn data(&self) -> &HashMap<String, Value> {
        &self.local_data
    }

    /// Get the last known remote hash.
    pub fn hash(&self) -> Option<&str> {
        self.last_hash.as_deref()
    }

    /// Get the last checkpoint timestamp.
    pub fn checkpoint(&self) -> u64 {
        self.last_checkpoint
    }

    /// Pull latest data from the server.
    pub async fn pull(&mut self) -> Result<PullResponse, SatelliteError> {
        let cp = if self.last_checkpoint > 0 {
            Some(self.last_checkpoint)
        } else {
            None
        };
        let mut result = self.client.pull(&self.pull_path, cp).await?;

        if let Some(enc) = &self.encryptor {
            let decrypted = enc.decrypt(&result.data)?;
            self.local_data = decrypted.clone();
            result.data = decrypted;
        } else if self.last_checkpoint > 0 {
            let mut local_val = serde_json::to_value(&self.local_data)
                .unwrap_or(Value::Object(Default::default()));
            let source_val = serde_json::to_value(&result.data)
                .unwrap_or(Value::Object(Default::default()));
            deep_assign(&mut local_val, &source_val);
            if let Value::Object(map) = local_val {
                self.local_data = map.into_iter().collect();
            }
        } else {
            self.local_data = result.data.clone();
        }

        self.last_hash = Some(result.hash.clone());
        self.last_checkpoint = result.timestamp;
        Ok(result)
    }

    /// Push data with automatic conflict resolution.
    pub async fn push(
        &mut self,
        data: HashMap<String, Value>,
    ) -> Result<PushSuccess, SatelliteError> {
        let mut attempt = 0u32;
        let mut pending_data = data;

        loop {
            let payload = if let Some(enc) = &self.encryptor {
                enc.encrypt(&pending_data)?
            } else {
                pending_data.clone()
            };

            let sig = if let Some(signer) = &self.signer {
                let data_val = serde_json::to_value(&pending_data)
                    .unwrap_or(Value::Object(Default::default()));
                Some(signer.sign(&stable_stringify(&data_val)).await?)
            } else {
                None
            };

            match self
                .client
                .push(&self.push_path, payload, self.last_hash.clone(), sig)
                .await
            {
                Ok(result) => {
                    self.last_hash = Some(result.hash.clone());
                    self.last_checkpoint = result.timestamp;
                    self.local_data = pending_data;
                    return Ok(PushSuccess {
                        hash: result.hash,
                        timestamp: result.timestamp,
                    });
                }
                Err(SatelliteError::Conflict) => {
                    if attempt >= self.max_retries {
                        return Err(SatelliteError::Conflict);
                    }

                    let remote = self.client.pull(&self.pull_path, None).await?;
                    self.last_hash = Some(remote.hash.clone());
                    self.last_checkpoint = remote.timestamp;

                    let remote_data = if let Some(enc) = &self.encryptor {
                        enc.decrypt(&remote.data)?
                    } else {
                        remote.data
                    };

                    let local_val = serde_json::to_value(&pending_data)
                        .unwrap_or(Value::Object(Default::default()));
                    let remote_val = serde_json::to_value(&remote_data)
                        .unwrap_or(Value::Object(Default::default()));
                    let merged = (self.merge)(&local_val, &remote_val);

                    if let Value::Object(map) = merged {
                        pending_data = map.into_iter().collect();
                    }
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

/// Push success result returned by SyncManager.
#[derive(Debug, Clone)]
pub struct PushSuccess {
    pub hash: String,
    pub timestamp: u64,
}
