/**
 * The local State DB: the per-file last-synced snapshot that forms the 3-way
 * merge base (docs/05-sync-engine.md). M0 ships an in-memory implementation;
 * a persistent implementation (IndexedDB vs plugin-data JSON — spike S3) lands
 * later. Kept behind an interface so the engine and tests don't care which.
 */
import type { StateEntry } from "../types.js";

export interface StateStore {
  all(): Promise<StateEntry[]>;
  get(path: string): Promise<StateEntry | undefined>;
  put(entry: StateEntry): Promise<void>;
  delete(path: string): Promise<void>;
  /** Snapshot as a path→entry map (convenience for the reconciler). */
  toMap(): Promise<Map<string, StateEntry>>;
}

export class MemoryStateStore implements StateStore {
  private readonly entries = new Map<string, StateEntry>();

  async all(): Promise<StateEntry[]> {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  async get(path: string): Promise<StateEntry | undefined> {
    const e = this.entries.get(path);
    return e ? { ...e } : undefined;
  }

  async put(entry: StateEntry): Promise<void> {
    this.entries.set(entry.path, { ...entry });
  }

  async delete(path: string): Promise<void> {
    this.entries.delete(path);
  }

  async toMap(): Promise<Map<string, StateEntry>> {
    return new Map([...this.entries].map(([k, v]) => [k, { ...v }]));
  }
}
