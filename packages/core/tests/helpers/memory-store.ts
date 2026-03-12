import type { IObjectStore } from "../../src/interfaces.js"

export class MemoryObjectStore implements IObjectStore {
  private store = new Map<string, string>()

  async getString(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async put(key: string, body: string): Promise<void> {
    this.store.set(key, body)
  }

  async list(prefix: string, opts: { startAfter?: string; limit?: number } = {}): Promise<string[]> {
    const keys = [...this.store.keys()]
      .filter(k => k.startsWith(prefix))
      .sort()
    const start = opts.startAfter
      ? keys.findIndex(k => k > opts.startAfter!)
      : 0
    const startIdx = start === -1 ? keys.length : start
    return keys.slice(startIdx, startIdx + (opts.limit ?? 1000))
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
  }

  async delMany(keys: string[]): Promise<void> {
    keys.forEach(k => this.store.delete(k))
  }
}
