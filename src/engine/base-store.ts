/**
 * BaseStore holds the last-synced ("common ancestor") content of text files, so
 * the engine can do a 3-way merge when a concurrent edit is detected (merge.ts).
 * It lives OUTSIDE the synced vault (device-local) and is keyed by vault path.
 *
 * M2.x ships an in-memory implementation for tests; the plugin uses an
 * adapter-backed one under its own (excluded) config folder.
 */
export interface BaseStore {
  get(path: string): Promise<ArrayBuffer | null>;
  set(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
}

export class MemoryBaseStore implements BaseStore {
  private readonly store = new Map<string, ArrayBuffer>();

  async get(path: string): Promise<ArrayBuffer | null> {
    const d = this.store.get(path);
    return d ? d.slice(0) : null;
  }

  async set(path: string, data: ArrayBuffer): Promise<void> {
    this.store.set(path, data.slice(0));
  }

  async delete(path: string): Promise<void> {
    this.store.delete(path);
  }
}
