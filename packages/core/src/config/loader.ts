import type { IObjectStore } from "../interfaces.js"
import { SyncConfigSchema } from "./schema.js"
import type { SyncConfig } from "./schema.js"
import { validateConfig } from "./validate.js"
import { StartupError } from "../errors.js"
import { DEFAULT_CONFIG_KEY, CONTENT_TYPE_JSON } from "../constants.js"

/**
 * Load and validate a SyncConfig from storage.
 * Returns null if no config exists at the given key.
 */
export async function loadConfig(
  store: IObjectStore,
  configKey = DEFAULT_CONFIG_KEY
): Promise<SyncConfig | null> {
  const raw = await store.getString(configKey)
  if (raw === null) return null

  const parsed = SyncConfigSchema.parse(JSON.parse(raw))
  const errors = validateConfig(parsed)
  if (errors.length > 0) {
    throw new StartupError(`Invalid sync config:\n${errors.join("\n")}`)
  }
  return parsed
}

/**
 * Save a SyncConfig to storage.
 * Validates before saving; throws on invalid config.
 */
export async function saveConfig(
  store: IObjectStore,
  config: SyncConfig,
  configKey = DEFAULT_CONFIG_KEY
): Promise<void> {
  // Validate schema
  SyncConfigSchema.parse(config)

  // Semantic validation
  const errors = validateConfig(config)
  if (errors.length > 0) {
    throw new StartupError(`Invalid sync config:\n${errors.join("\n")}`)
  }

  await store.put(configKey, JSON.stringify(config, null, 2), {
    contentType: CONTENT_TYPE_JSON,
  })
}
