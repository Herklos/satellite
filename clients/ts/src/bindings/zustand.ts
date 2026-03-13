import { createStore, type StoreApi } from "zustand/vanilla"
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware"
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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSatelliteStore(
  options: CreateSatelliteStoreOptions,
): StoreApi<SatelliteStore> {
  const { name, syncManager, storage } = options

  const storeCreator = (
    set: StoreApi<SatelliteStore>["setState"],
    get: StoreApi<SatelliteStore>["getState"],
  ): SatelliteStore => ({
    // -- state --
    data: {},
    syncing: false,
    online: true,
    dirty: false,
    error: null,

    // -- actions --
    pull: async () => {
      set({ syncing: true, error: null })
      try {
        await syncManager.pull()
        set({ data: syncManager.getData(), syncing: false })
      } catch (err) {
        set({ syncing: false, error: (err as Error).message })
      }
    },

    set: (modifier) => {
      const next = modifier(get().data)
      set({ data: next, dirty: true })
      if (get().online) get().flush()
    },

    flush: async () => {
      if (get().syncing || !get().dirty) return
      set({ syncing: true, error: null })
      try {
        await syncManager.push(get().data)
        set({ data: syncManager.getData(), syncing: false, dirty: false })
      } catch (err) {
        set({ syncing: false, error: (err as Error).message })
      }
    },

    setOnline: (online) => {
      set({ online })
      if (online && get().dirty) get().flush()
    },
  })

  // No persistence requested
  if (storage === false) {
    return createStore<SatelliteStore>()(storeCreator)
  }

  return createStore<SatelliteStore>()(
    persist(storeCreator, {
      name: `satellite-${name}`,
      storage: storage ? createJSONStorage(() => storage) : undefined,
      partialize: (state) => ({
        data: state.data,
        dirty: state.dirty,
      }),
    }),
  )
}
