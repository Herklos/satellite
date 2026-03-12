# Satellite

A generic document sync library. Pull/push documents with hash-based conflict detection, incremental sync via timestamps, and role-based access control.

Works with any storage backend (S3, MongoDB, in-memory) and any auth model. The server determines roles; the library enforces permissions.

## Packages

### Server

| Package | Description |
|---|---|
| `@satellite/core` | Protocol, encryption, config, and Hono router |
| `@satellite/s3-storage` | S3-compatible storage adapter (aws4fetch) |

### Client SDKs

| Package | Language | Description |
|---|---|---|
| `@satellite/client` | TypeScript | Browser, Node.js & React Native client with sync manager |
| `satellite-sdk` | Python | Async client (httpx) with sync manager |
| `satellite-sdk` | Rust | Native + WASM client with sync manager |

## Quick Start

```ts
import { createSyncRouter, loadConfig, saveConfig } from "@satellite/core/router"
import { S3ObjectStore } from "@satellite/s3-storage"
import { Hono } from "hono"

const store = new S3ObjectStore({
  accessKeyId: "...",
  secretAccessKey: "...",
  endpoint: "https://s3.amazonaws.com",
  bucket: "my-bucket",
})

// Seed config into storage (once)
await saveConfig(store, {
  version: 1,
  collections: [
    {
      name: "notes",
      storagePath: "users/{identity}/notes",
      readRoles: ["self"],
      writeRoles: ["self"],
      encryption: "identity",
      maxBodyBytes: 131072,
    },
    {
      name: "posts",
      storagePath: "posts/{postId}",
      readRoles: ["public"],
      writeRoles: ["admin"],
      encryption: "none",
      maxBodyBytes: 65536,
    },
  ],
})

// Load config and create router
const config = await loadConfig(store)

const router = createSyncRouter({
  store,
  config: config!,
  roleResolver: async (req) => {
    const token = req.headers.get("Authorization")
    const user = await verifyToken(token) // your auth logic
    return { identity: user.id, roles: user.roles }
  },
  encryptionSecret: process.env.ENCRYPTION_SECRET,
})

const app = new Hono()
app.route("/v1", router)
export default app
```

## Protocol

Documents are synced using a pull/push model with hash-based optimistic concurrency.

**Pull** — `GET /pull/{storagePath}?checkpoint={ts}`
- Returns the full document data (or only changes since checkpoint)
- Always returns the hash of the full document

**Push** — `POST /push/{storagePath}`
```json
{ "data": { ... }, "baseHash": "abc123" }
```
- `baseHash` must match the current document hash (optimistic lock)
- `baseHash: null` for first push (document must not exist)
- Returns `409` on hash mismatch (conflict)
- Per-key timestamps track which fields changed when

## Config

Collection configuration is stored **inside the storage** at `__sync__/config.json`. Each collection defines:

```ts
{
  name: "invoices",                        // unique identifier
  storagePath: "users/{identity}/invoices", // document key template
  readRoles: ["self", "admin"],            // who can pull
  writeRoles: ["self"],                    // who can push
  encryption: "identity",                  // "none" | "identity" | "server"
  maxBodyBytes: 65536,                     // body size limit
}
```

### Roles

Roles are opaque strings resolved by your `roleResolver` callback. Two special roles:

- **`"public"`** — no authentication required
- **`"self"`** — auto-granted when `{identity}` in the URL matches the authenticated user's identity

Use `roleEnricher` for context-dependent roles (e.g. resource ownership):

```ts
createSyncRouter({
  // ...
  roleEnricher: async (auth, params) => {
    if (params.postId && await isOwner(auth.identity, params.postId)) {
      return ["owner"]
    }
    return []
  },
})
```

### Encryption

- **`"none"`** — stored in plaintext
- **`"identity"`** — encrypted per-user with HKDF(secret, identity). Only the user can read their data.
- **`"server"`** — encrypted with a server-wide key. All server code can read; clients cannot read raw storage.

### Bundles

Collections with the same `bundle` value share a storage path and get a combined pull endpoint:

```ts
{ name: "settings", storagePath: "users/{identity}", bundle: "user-data", ... },
{ name: "favorites", storagePath: "users/{identity}", bundle: "user-data", ... },
```

`GET /pull/users/:identity` returns all bundled collections. Push remains per-collection.

## Client SDKs

All clients implement the same protocol: pull/push with hash-based conflict detection, incremental sync via checkpoints, optional E2E encryption, and automatic conflict resolution.

### TypeScript

Works in Browser, Node.js, and React Native (see [Platform Support](#platform-support)).

```ts
import { SatelliteClient, SyncManager } from "@satellite/client"

const client = new SatelliteClient({
  baseUrl: "https://api.example.com/v1",
  auth: async ({ method, path, body }) => ({
    Authorization: `Bearer ${await getToken()}`,
  }),
})

// Low-level: pull/push directly
const pulled = await client.pull("/pull/users/abc/settings")
await client.push("/push/users/abc/settings", { theme: "dark" }, pulled.hash)

// High-level: SyncManager handles conflicts automatically
const sync = new SyncManager({
  client,
  pullPath: "/pull/users/abc/settings",
  pushPath: "/push/users/abc/settings",
})

await sync.pull()
await sync.push({ theme: "dark", lang: "en" })
// Or: pull-modify-push in one call
await sync.update((data) => ({ ...data, theme: "light" }))
```

#### Full example: Auth + E2E Encryption + Author Signing

```ts
import { SatelliteClient, SyncManager } from "@satellite/client"

// 1. Create client with auth
const client = new SatelliteClient({
  baseUrl: "https://api.example.com/v1",
  auth: async ({ method, path, body }) => ({
    "X-Pubkey": myPubkey,
    "X-Signature": await sign(method + path + (body ?? "")),
  }),
  // Optional: custom fetch for environments that need it
  // fetch: customFetch,
})

// 2. Create sync manager with encryption and signing
const sync = new SyncManager({
  client,
  pullPath: "/pull/users/abc/notes",
  pushPath: "/push/users/abc/notes",
  // E2E encryption: data is encrypted client-side before push,
  // decrypted after pull. The server never sees plaintext.
  encryptionSecret: "user-secret-key",
  encryptionSalt: "user-abc",
  encryptionInfo: "satellite-e2e", // optional, default: "satellite-e2e"
  // Author signing: sign data for provenance verification
  signData: async (data) => await sign(data),
  // Custom conflict resolver (default: remote-wins deep merge)
  onConflict: (local, remote) => ({ ...remote, ...local }),
  maxRetries: 3,
})

// 3. Sync
await sync.pull()
console.log(sync.getData()) // decrypted data

await sync.push({ notes: ["hello world"] }) // encrypted + signed automatically

// Or pull-modify-push in one call
await sync.update((current) => ({
  ...current,
  notes: [...(current.notes as string[]), "new note"],
}))
```

### Python

```python
from satellite_sdk import SatelliteClient, SyncManager

async with SatelliteClient(
    "https://api.example.com/v1",
    auth=my_auth_provider,
) as client:
    # Low-level
    pulled = await client.pull("/pull/users/abc/settings")
    await client.push("/push/users/abc/settings", {"theme": "dark"}, pulled.hash)

    # High-level
    sync = SyncManager(
        client,
        "/pull/users/abc/settings",
        "/push/users/abc/settings",
        encryption_secret="my-secret",
        encryption_salt="user-abc",
    )
    await sync.pull()
    await sync.push({"theme": "dark", "lang": "en"})
```

### Rust

```rust
use satellite_sdk::{SatelliteClient, SyncManager, SyncManagerOptions};

let client = SatelliteClient::new("https://api.example.com/v1", None);

// Low-level
let pulled = client.pull("/pull/users/abc/settings", None).await?;

// High-level
let mut sync = SyncManager::new(SyncManagerOptions {
    client,
    pull_path: "/pull/users/abc/settings".into(),
    push_path: "/push/users/abc/settings".into(),
    encryption_secret: Some("my-secret".into()),
    encryption_salt: Some("user-abc".into()),
    ..Default::default()
})?;
sync.pull().await?;
```

The Rust client supports both native (reqwest) and WASM (gloo-net) targets via feature flags:

```toml
# Native (default)
satellite-sdk = "0.1"

# WASM
satellite-sdk = { version = "0.1", default-features = false, features = ["wasm"] }
```

### Auth Provider

All clients use a generic auth provider that returns headers. This decouples the SDK from any specific auth scheme:

```ts
// Bearer token
auth: async () => ({ Authorization: `Bearer ${token}` })

// API key
auth: async () => ({ "X-API-Key": apiKey })

// Custom signing (e.g. blockchain, HMAC)
auth: async ({ method, path, body }) => ({
  "X-Pubkey": pubkey,
  "X-Signature": await sign(method + path + body),
})
```

### Client-Side Encryption

All clients support optional AES-256-GCM encryption with HKDF-derived keys. When enabled, data is encrypted before push and decrypted after pull — the server never sees plaintext.

You can also use the encryptor standalone:

```ts
import { createEncryptor } from "@satellite/client"

const encryptor = createEncryptor("my-secret", "user-abc")
const encrypted = await encryptor.encrypt({ hello: "world" })
// => { _encrypted: "base64..." }
const decrypted = await encryptor.decrypt(encrypted)
// => { hello: "world" }
```

### Platform Support

The TypeScript client uses the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) and has zero production dependencies.

| Platform | Status | Notes |
|---|---|---|
| Browser | Works out of the box | Web Crypto API is native |
| Node.js >= 15 | Works out of the box | `crypto.subtle` available globally |
| React Native | Requires setup | See below |

#### React Native Setup

React Native's JS engines (Hermes, JSC) don't provide the Web Crypto API. Call `configurePlatform()` once at app startup before using the SDK:

```ts
import { configurePlatform } from "@satellite/client"
import QuickCrypto from "react-native-quick-crypto"

configurePlatform({
  crypto: QuickCrypto,
  base64: {
    encode: (data) => Buffer.from(data).toString("base64"),
    decode: (str) => new Uint8Array(Buffer.from(str, "base64")),
  },
})

// Now use the SDK normally
import { SyncManager } from "@satellite/client"
```

Alternatively, if your polyfill patches `globalThis.crypto` (e.g., `react-native-quick-crypto/polyfill`), no explicit configuration is needed.

## Storage Adapter

Implement `IObjectStore` for your backend:

```ts
import type { IObjectStore } from "@satellite/core"

class MongoObjectStore implements IObjectStore {
  async getString(key: string): Promise<string | null> { /* ... */ }
  async put(key: string, body: string, opts?): Promise<void> { /* ... */ }
  async list(prefix: string, opts?): Promise<string[]> { /* ... */ }
  async del(key: string): Promise<void> { /* ... */ }
  async delMany(keys: string[]): Promise<void> { /* ... */ }
}
```

## Development

```bash
pnpm install
pnpm test        # run all tests
pnpm typecheck   # typecheck all packages
pnpm build       # build all packages
```
