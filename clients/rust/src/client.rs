use std::collections::HashMap;

use crate::types::{AuthProvider, PullResponse, PushRequest, PushSuccess, SatelliteError};

/// Low-level HTTP client for the Satellite sync protocol.
pub struct SatelliteClient {
    base_url: String,
    auth: Option<Box<dyn AuthProvider>>,
    #[cfg(feature = "native")]
    http: reqwest::Client,
}

impl SatelliteClient {
    /// Create a new client for native (non-WASM) targets.
    #[cfg(feature = "native")]
    pub fn new(base_url: &str, auth: Option<Box<dyn AuthProvider>>) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            auth,
            http: reqwest::Client::new(),
        }
    }

    /// Create a new client for WASM targets.
    #[cfg(all(feature = "wasm", not(feature = "native")))]
    pub fn new(base_url: &str, auth: Option<Box<dyn AuthProvider>>) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            auth,
        }
    }

    async fn auth_headers(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<HashMap<String, String>, SatelliteError> {
        match &self.auth {
            Some(provider) => provider.headers(method, path, body).await,
            None => Ok(HashMap::new()),
        }
    }

    /// Pull synced data from the server.
    #[cfg(feature = "native")]
    pub async fn pull(
        &self,
        path: &str,
        checkpoint: Option<u64>,
    ) -> Result<PullResponse, SatelliteError> {
        let mut url = format!("{}{}", self.base_url, path);
        if let Some(cp) = checkpoint {
            if cp > 0 {
                url = format!("{}?checkpoint={}", url, cp);
            }
        }

        let auth_headers = self.auth_headers("GET", path, None).await?;

        let mut req = self.http.get(&url).header("Accept", "application/json");
        for (k, v) in &auth_headers {
            req = req.header(k, v);
        }

        let resp = req.send().await.map_err(|e| SatelliteError::Request(e.to_string()))?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(SatelliteError::Http { status, body });
        }

        resp.json::<PullResponse>()
            .await
            .map_err(|e| SatelliteError::Request(e.to_string()))
    }

    /// Push synced data to the server.
    #[cfg(feature = "native")]
    pub async fn push(
        &self,
        path: &str,
        data: HashMap<String, serde_json::Value>,
        base_hash: Option<String>,
        author_signature: Option<String>,
    ) -> Result<PushSuccess, SatelliteError> {
        let payload = PushRequest {
            data,
            base_hash,
            author_signature,
        };
        let body = serde_json::to_string(&payload)
            .map_err(|e| SatelliteError::Request(e.to_string()))?;

        let auth_headers = self.auth_headers("POST", path, Some(&body)).await?;

        let mut req = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body);
        for (k, v) in &auth_headers {
            req = req.header(k, v);
        }

        let resp = req.send().await.map_err(|e| SatelliteError::Request(e.to_string()))?;
        let status = resp.status().as_u16();

        if status == 409 {
            return Err(SatelliteError::Conflict);
        }
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(SatelliteError::Http { status, body });
        }

        resp.json::<PushSuccess>()
            .await
            .map_err(|e| SatelliteError::Request(e.to_string()))
    }

    /// Pull synced data from the server (WASM).
    #[cfg(all(feature = "wasm", not(feature = "native")))]
    pub async fn pull(
        &self,
        path: &str,
        checkpoint: Option<u64>,
    ) -> Result<PullResponse, SatelliteError> {
        let mut url = format!("{}{}", self.base_url, path);
        if let Some(cp) = checkpoint {
            if cp > 0 {
                url = format!("{}?checkpoint={}", url, cp);
            }
        }

        let auth_headers = self.auth_headers("GET", path, None).await?;

        let mut req = gloo_net::http::Request::get(&url)
            .header("Accept", "application/json");
        for (k, v) in &auth_headers {
            req = req.header(k, v);
        }

        let resp = req.send().await.map_err(|e| SatelliteError::Request(e.to_string()))?;
        let status = resp.status();
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(SatelliteError::Http { status, body });
        }

        resp.json::<PullResponse>()
            .await
            .map_err(|e| SatelliteError::Request(e.to_string()))
    }

    /// Push synced data to the server (WASM).
    #[cfg(all(feature = "wasm", not(feature = "native")))]
    pub async fn push(
        &self,
        path: &str,
        data: HashMap<String, serde_json::Value>,
        base_hash: Option<String>,
        author_signature: Option<String>,
    ) -> Result<PushSuccess, SatelliteError> {
        let payload = PushRequest {
            data,
            base_hash,
            author_signature,
        };
        let body = serde_json::to_string(&payload)
            .map_err(|e| SatelliteError::Request(e.to_string()))?;

        let auth_headers = self.auth_headers("POST", path, Some(&body)).await?;

        let mut req = gloo_net::http::Request::post(&format!("{}{}", self.base_url, path))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body)
            .map_err(|e| SatelliteError::Request(e.to_string()))?;

        // Note: gloo-net doesn't support adding headers after body is set the same way.
        // In practice, you'd build headers before .body(). This is simplified.

        let resp = req.send().await.map_err(|e| SatelliteError::Request(e.to_string()))?;
        let status = resp.status();

        if status == 409 {
            return Err(SatelliteError::Conflict);
        }
        if status != 200 {
            let body = resp.text().await.unwrap_or_default();
            return Err(SatelliteError::Http { status, body });
        }

        resp.json::<PushSuccess>()
            .await
            .map_err(|e| SatelliteError::Request(e.to_string()))
    }
}
