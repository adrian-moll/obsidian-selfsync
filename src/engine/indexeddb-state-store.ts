/**
 * IndexedDB-backed StateStore (spike S3). The last-synced snapshot is kept in an
 * IndexedDB object store keyed by path, mirrored in memory for fast reads. Unlike
 * JsonStateStore — which re-serializes the WHOLE snapshot to data.json on every
 * write — this persists only the keys that changed, in a single transaction per
 * flush(), so a sync that touches a few files costs O(changed), not O(total). That
 * matters on large vaults (tens of thousands of files).
 *
 * Losing this store is safe: it's a cache. reconcile-on-startup rebuilds the base
 * by re-hashing the vault against the remote manifest (no data transfer, since
 * hashes match). `createStateStore` falls back to JsonStateStore when IndexedDB is
 * unavailable, so the plugin always works.
 */
import type { StateEntry } from "../types.js";
import { JsonStateStore, type StateStore } from "./state-db.js";

const STORE_NAME = "state";

/** Promisify an IDBRequest. */
function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolve when a readwrite transaction commits (or reject if it aborts). */
function txnDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDb(indexedDB: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "path" });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error(`IndexedDB open blocked for ${dbName}`));
  });
}

export class IndexedDbStateStore implements StateStore {
  private readonly entries: Map<string, StateEntry>;
  private batching = false;
  private readonly pendingPuts = new Map<string, StateEntry>();
  private readonly pendingDeletes = new Set<string>();

  private constructor(
    private readonly db: IDBDatabase,
    initial: StateEntry[],
  ) {
    this.entries = new Map(initial.map((e) => [e.path, { ...e }]));
  }

  /** Open the database and load all rows into memory. */
  static async open(indexedDB: IDBFactory, dbName: string): Promise<IndexedDbStateStore> {
    const db = await openDb(indexedDB, dbName);
    const tx = db.transaction(STORE_NAME, "readonly");
    const rows = (await req(tx.objectStore(STORE_NAME).getAll())) as StateEntry[];
    return new IndexedDbStateStore(db, rows);
  }

  /** Number of entries held (in memory). */
  count(): number {
    return this.entries.size;
  }

  /** Bulk-import entries in one transaction (used to migrate from data.json). */
  async importAll(all: StateEntry[]): Promise<void> {
    if (all.length === 0) return;
    const tx = this.db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const e of all) {
      const clone = { ...e };
      this.entries.set(e.path, clone);
      store.put(clone);
    }
    await txnDone(tx);
  }

  async all(): Promise<StateEntry[]> {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  async get(path: string): Promise<StateEntry | undefined> {
    const e = this.entries.get(path);
    return e ? { ...e } : undefined;
  }

  async toMap(): Promise<Map<string, StateEntry>> {
    return new Map([...this.entries].map(([k, v]) => [k, { ...v }]));
  }

  async put(entry: StateEntry): Promise<void> {
    const clone = { ...entry };
    this.entries.set(entry.path, clone);
    if (this.batching) {
      this.pendingDeletes.delete(entry.path);
      this.pendingPuts.set(entry.path, clone);
      return;
    }
    const tx = this.db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(clone);
    await txnDone(tx);
  }

  async delete(path: string): Promise<void> {
    this.entries.delete(path);
    if (this.batching) {
      this.pendingPuts.delete(path);
      this.pendingDeletes.add(path);
      return;
    }
    const tx = this.db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(path);
    await txnDone(tx);
  }

  beginBatch(): void {
    this.batching = true;
  }

  async flush(): Promise<void> {
    if (!this.batching) return;
    this.batching = false;
    if (this.pendingPuts.size === 0 && this.pendingDeletes.size === 0) return;
    const tx = this.db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const entry of this.pendingPuts.values()) store.put(entry);
    for (const path of this.pendingDeletes) store.delete(path);
    this.pendingPuts.clear();
    this.pendingDeletes.clear();
    await txnDone(tx);
  }

  async clear(): Promise<void> {
    this.batching = false;
    this.pendingPuts.clear();
    this.pendingDeletes.clear();
    this.entries.clear();
    const tx = this.db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    await txnDone(tx);
  }
}

export interface StateStoreFactoryOptions {
  /** The IndexedDB factory (e.g. window.indexedDB), or undefined if unavailable. */
  indexedDB: IDBFactory | undefined;
  /** Per-vault database name (IndexedDB is origin-scoped — must be namespaced). */
  dbName: string;
  /** Entries loaded from data.json (migration source + fallback state). */
  legacyEntries: StateEntry[];
  /** Persist callback for the JSON fallback (writes the whole snapshot). */
  jsonPersist: (all: StateEntry[]) => Promise<void>;
}

export interface StateStoreResult {
  store: StateStore;
  backend: "indexeddb" | "json";
  /** True if legacy data.json entries were imported into IndexedDB this run. */
  migrated: boolean;
}

/**
 * Select the state backend: IndexedDB when available (migrating any legacy
 * data.json entries on first use), else JsonStateStore. Never throws — any
 * IndexedDB failure degrades to the JSON fallback.
 */
export async function createStateStore(opts: StateStoreFactoryOptions): Promise<StateStoreResult> {
  const { indexedDB, dbName, legacyEntries, jsonPersist } = opts;
  if (!indexedDB) {
    return { store: new JsonStateStore(legacyEntries, jsonPersist), backend: "json", migrated: false };
  }
  try {
    const store = await IndexedDbStateStore.open(indexedDB, dbName);
    let migrated = false;
    if (store.count() === 0 && legacyEntries.length > 0) {
      await store.importAll(legacyEntries);
      migrated = true;
    }
    return { store, backend: "indexeddb", migrated };
  } catch {
    return { store: new JsonStateStore(legacyEntries, jsonPersist), backend: "json", migrated: false };
  }
}
