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
  /**
   * Defer persistence until {@link flush}. Between beginBatch() and flush(),
   * put/delete only mutate memory and skip the (expensive) whole-DB persist,
   * so a large batch serializes the DB once instead of once per entry. Stores
   * that don't persist may treat these as no-ops.
   */
  beginBatch(): void;
  flush(): Promise<void>;
}

/**
 * StateStore that mirrors entries in memory and persists the whole snapshot via
 * an injected callback (in the plugin: the plugin's own data file). Simple and
 * correct for M1; a chunked/IndexedDB store is a later optimization (spike S3).
 */
export class JsonStateStore implements StateStore {
  private readonly entries: Map<string, StateEntry>;
  /** When true, put/delete defer persistence until flush() (see beginBatch). */
  private batching = false;

  constructor(
    initial: StateEntry[],
    private readonly persist: (all: StateEntry[]) => Promise<void>,
  ) {
    this.entries = new Map(initial.map((e) => [e.path, { ...e }]));
  }

  private snapshot(): StateEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  async all(): Promise<StateEntry[]> {
    return this.snapshot();
  }

  async get(path: string): Promise<StateEntry | undefined> {
    const e = this.entries.get(path);
    return e ? { ...e } : undefined;
  }

  async put(entry: StateEntry): Promise<void> {
    this.entries.set(entry.path, { ...entry });
    if (!this.batching) await this.persist(this.snapshot());
  }

  async delete(path: string): Promise<void> {
    this.entries.delete(path);
    if (!this.batching) await this.persist(this.snapshot());
  }

  beginBatch(): void {
    this.batching = true;
  }

  async flush(): Promise<void> {
    if (!this.batching) return;
    this.batching = false;
    await this.persist(this.snapshot());
  }

  async toMap(): Promise<Map<string, StateEntry>> {
    return new Map([...this.entries].map(([k, v]) => [k, { ...v }]));
  }
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

  beginBatch(): void {
    // No persistence to defer.
  }

  async flush(): Promise<void> {
    // No persistence to flush.
  }

  async toMap(): Promise<Map<string, StateEntry>> {
    return new Map([...this.entries].map(([k, v]) => [k, { ...v }]));
  }
}
