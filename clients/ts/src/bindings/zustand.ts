import { createStore, type StoreApi } from "zustand/vanilla"
import {
  persist,
  devtools,
  subscribeWithSelector,
  createJSONStorage,
  type StateStorage,
  type DevtoolsOptions,
} from "zustand/middleware"
import type { SyncManager } from "../sync.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SatelliteState {
  /** Current local data snapshot */
  data: Record<string, unknown>
  /** Whether a sync operation (pull/push) is in progress */
  syncing: boolean
  /** Whether the device is considered online */
  online: boolean
  /** Whether local data has un-pushed changes */
  dirty: boolean
  /** Last sync error message, if any */
  error: string | null
}

export interface SatelliteActions {
  /** Pull remote state and merge into local */
  pull: () => Promise<void>
  /** Optimistic local write — instant, no network roundtrip */
  set: (modifier: (current: Record<string, unknown>) => Record<string, unknown>) => void
  /** Push pending local changes to the server */
  flush: () => Promise<void>
  /** Update connectivity status; auto-flushes dirty data when going online */
  setOnline: (online: boolean) => void
}

export type SatelliteStore = SatelliteState & SatelliteActions

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateSatelliteStoreOptions {
  /** Unique name used as the persistence key (prefixed with `satellite-`) */
  name: string
  /** A configured SyncManager instance for this collection */
  syncManager: SyncManager
  /**
   * Storage backend for persistence.
   *
   * - **Browser**: omit — uses `localStorage` by default.
   * - **React Native**: pass `AsyncStorage` from `@react-native-async-storage/async-storage`.
   * - **None**: pass `false` to disable persistence entirely.
   */
  storage?: StateStorage | false
  /**
   * Enable Redux DevTools integration.
   *
   * - `true` — enable with default options (store name = `satellite-{name}`).
   * - `DevtoolsOptions` — enable with custom options.
   * - `false` / omit — disabled.
   */
  devtools?: boolean | DevtoolsOptions
  /**
   * Pass `produce` from `immer` to enable draft-based mutations in `set()`.
   *
   * When provided, the modifier passed to `set()` can mutate its argument:
   * ```ts
   * store.getState().set((draft) => { draft.theme = "dark" })
   * ```
   *
   * The existing return-new-object pattern still works:
   * ```ts
   * store.getState().set((d) => ({ ...d, theme: "dark" }))
   * ```
   */
  produce?: <T>(base: T, recipe: (draft: T) => T | void) => T
}

// Re-export DevtoolsOptions for convenience
export type { DevtoolsOptions }

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSatelliteStore(
  options: CreateSatelliteStoreOptions,
): StoreApi<SatelliteStore> {
  const { name, syncManager, storage } = options

  // The 3rd argument (action name) is injected by the devtools middleware at
  // runtime regardless of whether devtools is enabled.  We cast once here so
  // every call site stays clean.
  type NamedSet = (partial: Partial<SatelliteStore>, replace?: boolean, action?: string) => void

  const storeCreator = (
    rawSet: StoreApi<SatelliteStore>["setState"],
    get: StoreApi<SatelliteStore>["getState"],
  ): SatelliteStore => {
    const set = rawSet as NamedSet
    return {
    // -- state --
    data: {},
    syncing: false,
    online: true,
    dirty: false,
    error: null,

    // -- actions --
    pull: async () => {
      set({ syncing: true, error: null }, false, "pull/start")
      try {
        await syncManager.pull()
        set({ data: syncManager.getData(), syncing: false }, false, "pull/success")
      } catch (err) {
        set({ syncing: false, error: (err as Error).message }, false, "pull/error")
      }
    },

    set: (modifier) => {
      const next = options.produce
        ? options.produce(get().data, modifier as (draft: Record<string, unknown>) => Record<string, unknown> | void)
        : modifier(get().data)
      set({ data: next, dirty: true }, false, "set")
      if (get().online) get().flush()
    },

    flush: async () => {
      if (get().syncing || !get().dirty) return
      set({ syncing: true, error: null }, false, "flush/start")
      try {
        await syncManager.push(get().data)
        set({ data: syncManager.getData(), syncing: false, dirty: false }, false, "flush/success")
      } catch (err) {
        set({ syncing: false, error: (err as Error).message }, false, "flush/error")
      }
    },

    setOnline: (online) => {
      set({ online }, false, "setOnline")
      if (online && get().dirty) get().flush()
    },
  }}

  // Build middleware chain:
  //   persist (optional) → subscribeWithSelector (always) → devtools (optional)

  const withPersist = storage === false
    ? storeCreator
    : persist(storeCreator, {
        name: `satellite-${name}`,
        storage: storage ? createJSONStorage(() => storage) : undefined,
        partialize: (state) => ({
          data: state.data,
          dirty: state.dirty,
        }),
      })

  const withSelector = subscribeWithSelector(withPersist)

  if (options.devtools) {
    const devtoolsOpts: DevtoolsOptions =
      typeof options.devtools === "object"
        ? options.devtools
        : { name: `satellite-${name}` }
    return createStore<SatelliteStore>()(devtools(withSelector, devtoolsOpts))
  }

  return createStore<SatelliteStore>()(withSelector)
}
