import type { StorageAdapter } from '../adapters/types.js';

/** In-memory StorageAdapter (playground session state, tests). Values are deep-copied via structuredClone. */
export class MemoryStorage implements StorageAdapter {
  private readonly map = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.has(key) ? (structuredClone(this.map.get(key)) as T) : undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
