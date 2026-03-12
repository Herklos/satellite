use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use serde_json::Value;
use std::collections::HashMap;

use crate::types::SatelliteError;

const IV_BYTES: usize = 12;
const DEFAULT_INFO: &str = "satellite-e2e";

/// Key used in the encrypted wire-format wrapper object.
pub const ENCRYPTED_KEY: &str = "_encrypted";

/// AES-256-GCM encryptor with HKDF-derived keys for client-side E2E encryption.
pub struct Encryptor {
    cipher: Aes256Gcm,
}

impl Encryptor {
    /// Create a new Encryptor.
    ///
    /// # Arguments
    /// * `secret` - Secret string for key derivation.
    /// * `salt` - Salt for HKDF (typically the user's identity).
    /// * `info` - HKDF info string for domain separation (default: "satellite-e2e").
    pub fn new(secret: &str, salt: &str, info: Option<&str>) -> Result<Self, SatelliteError> {
        let info = info.unwrap_or(DEFAULT_INFO);
        let key = derive_key(secret, salt, info)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| SatelliteError::Encryption(e.to_string()))?;
        Ok(Self { cipher })
    }

    /// Encrypt a data object into `{ "_encrypted": "<base64>" }`.
    pub fn encrypt(
        &self,
        data: &HashMap<String, Value>,
    ) -> Result<HashMap<String, Value>, SatelliteError> {
        let plaintext = serde_json::to_vec(data)
            .map_err(|e| SatelliteError::Encryption(e.to_string()))?;

        let mut iv = [0u8; IV_BYTES];
        rand::thread_rng().fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_ref())
            .map_err(|e| SatelliteError::Encryption(e.to_string()))?;

        let mut combined = Vec::with_capacity(IV_BYTES + ciphertext.len());
        combined.extend_from_slice(&iv);
        combined.extend_from_slice(&ciphertext);

        let encoded = BASE64.encode(&combined);
        let mut result = HashMap::new();
        result.insert(ENCRYPTED_KEY.to_string(), Value::String(encoded));
        Ok(result)
    }

    /// Decrypt an encrypted wrapper back to the original data.
    /// Returns the wrapper as-is if it does not contain the encrypted key.
    pub fn decrypt(
        &self,
        wrapper: &HashMap<String, Value>,
    ) -> Result<HashMap<String, Value>, SatelliteError> {
        let encoded = match wrapper.get(ENCRYPTED_KEY) {
            Some(Value::String(s)) => s,
            _ => return Ok(wrapper.clone()),
        };

        let combined = BASE64
            .decode(encoded)
            .map_err(|e| SatelliteError::Encryption(e.to_string()))?;

        if combined.len() < IV_BYTES {
            return Err(SatelliteError::Encryption("ciphertext too short".into()));
        }

        let iv = &combined[..IV_BYTES];
        let ciphertext = &combined[IV_BYTES..];
        let nonce = Nonce::from_slice(iv);

        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| SatelliteError::Encryption(e.to_string()))?;

        serde_json::from_slice(&plaintext)
            .map_err(|e| SatelliteError::Encryption(e.to_string()))
    }
}

fn derive_key(secret: &str, salt: &str, info: &str) -> Result<[u8; 32], SatelliteError> {
    let hk = Hkdf::<Sha256>::new(Some(salt.as_bytes()), secret.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(info.as_bytes(), &mut key)
        .map_err(|e| SatelliteError::Encryption(e.to_string()))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_encrypt_decrypt_round_trip() {
        let enc = Encryptor::new("test-secret", "test-salt", None).unwrap();
        let mut data = HashMap::new();
        data.insert("hello".to_string(), json!("world"));

        let encrypted = enc.encrypt(&data).unwrap();
        assert!(encrypted.contains_key(ENCRYPTED_KEY));

        let decrypted = enc.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted.get("hello").unwrap(), &json!("world"));
    }

    #[test]
    fn test_decrypt_unencrypted_passthrough() {
        let enc = Encryptor::new("test-secret", "test-salt", None).unwrap();
        let mut data = HashMap::new();
        data.insert("plain".to_string(), json!("data"));

        let result = enc.decrypt(&data).unwrap();
        assert_eq!(result.get("plain").unwrap(), &json!("data"));
    }

    #[test]
    fn test_wrong_key_fails() {
        let enc1 = Encryptor::new("secret-1", "salt", None).unwrap();
        let enc2 = Encryptor::new("secret-2", "salt", None).unwrap();

        let mut data = HashMap::new();
        data.insert("key".to_string(), json!("value"));

        let encrypted = enc1.encrypt(&data).unwrap();
        assert!(enc2.decrypt(&encrypted).is_err());
    }
}
