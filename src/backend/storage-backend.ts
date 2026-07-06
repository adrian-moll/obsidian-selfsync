/**
 * StorageBackend — a thin, dumb blob store. All sync intelligence (diff,
 * conflicts, tombstones, E2EE) lives in the engine ABOVE this interface, so
 * every backend (WebDAV, CouchDB, future S3) behaves identically
 * (docs/06-backends.md).
 */

export interface RemoteEntry {
  key: string; // opaque storage key
  size: number;
  etag?: string; // version token for optimistic concurrency, if supported
  mtime?: number;
}

export interface BackendCapabilities {
  /** Whether the backend honors conditional writes (If-Match / _rev). */
  conditionalWrites: boolean;
}

/** Thrown when a conditional write fails because the etag no longer matches. */
export class ConditionalWriteError extends Error {
  constructor(public readonly key: string) {
    super(`Conditional write failed for key: ${key}`);
    this.name = "ConditionalWriteError";
  }
}

export interface StorageBackend {
  testConnection(): Promise<void>;
  list(): Promise<RemoteEntry[]>;
  read(key: string): Promise<ArrayBuffer>;
  /**
   * Store a blob. If `prevEtag` is provided and the backend supports conditional
   * writes, the write MUST fail (throw ConditionalWriteError) if the current
   * etag differs. Returns the new etag.
   */
  write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string>;
  remove(key: string, prevEtag?: string): Promise<void>;
  capabilities(): BackendCapabilities;
}

interface StoredBlob {
  data: ArrayBuffer;
  etag: string;
}

/**
 * In-memory StorageBackend for tests. Supports conditional writes so the
 * manifest optimistic-concurrency path can be exercised without a container.
 */
export class MemoryBackend implements StorageBackend {
  private readonly blobs = new Map<string, StoredBlob>();
  private etagCounter = 0;

  private nextEtag(): string {
    return `etag-${++this.etagCounter}`;
  }

  async testConnection(): Promise<void> {
    /* always reachable */
  }

  async list(): Promise<RemoteEntry[]> {
    return [...this.blobs.entries()].map(([key, b]) => ({
      key,
      size: b.data.byteLength,
      etag: b.etag,
    }));
  }

  async read(key: string): Promise<ArrayBuffer> {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`Not found: ${key}`);
    return b.data.slice(0);
  }

  async write(key: string, data: ArrayBuffer, prevEtag?: string): Promise<string> {
    const existing = this.blobs.get(key);
    if (prevEtag !== undefined) {
      const currentEtag = existing?.etag;
      if (currentEtag !== prevEtag) throw new ConditionalWriteError(key);
    }
    const etag = this.nextEtag();
    this.blobs.set(key, { data: data.slice(0), etag });
    return etag;
  }

  async remove(key: string, prevEtag?: string): Promise<void> {
    const existing = this.blobs.get(key);
    if (prevEtag !== undefined && existing && existing.etag !== prevEtag) {
      throw new ConditionalWriteError(key);
    }
    this.blobs.delete(key);
  }

  capabilities(): BackendCapabilities {
    return { conditionalWrites: true };
  }
}
