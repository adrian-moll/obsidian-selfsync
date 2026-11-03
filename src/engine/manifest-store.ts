/**
 * Reads and commits the remote manifest as a single blob on the backend, using
 * the backend's etag for optimistic concurrency (docs/05-sync-engine.md). The
 * manifest is stored under a fixed key; content blobs live under separate keys.
 *
 * With a {@link ManifestCache} (kept by the plugin for the session) a load whose
 * etag matches the last one seen skips the download: an idle sync then costs a
 * single small etag request instead of transferring the whole manifest.
 */
import type { Manifest } from "../types.js";
import { emptyManifest } from "./manifest.js";
import type { StorageBackend } from "../backend/storage-backend.js";
import { utf8 } from "../backend/http.js";

export interface LoadedManifest {
  manifest: Manifest;
  /** Etag of the manifest blob as loaded, for a later conditional commit. */
  etag?: string;
}

/**
 * The last manifest seen (loaded or committed), as serialized JSON. Stored as
 * text so every load hands the engine a fresh object — it mutates the manifest
 * in place. Must be scoped to ONE backend + layout (the caller resets it when
 * the connection or encryption settings change).
 */
export interface ManifestCache {
  entry: { etag: string; json: string } | null;
}

export class ManifestStore {
  constructor(
    private readonly backend: StorageBackend,
    private readonly device: string,
    /** Backend key of the manifest (depends on layout — see BlobNaming). */
    private readonly manifestKey: string,
    private readonly cache?: ManifestCache,
  ) {}

  async load(): Promise<LoadedManifest> {
    // Ask for the etag first (cheap, and ordered before the data — see
    // StorageBackend.etag). Null means absent OR unknown, so fall through to a
    // full read, which tells the two apart.
    const etag = this.backend.etag ? await this.backend.etag(this.manifestKey) : null;
    if (etag) {
      const cached = this.cache?.entry;
      if (cached && cached.etag === etag) {
        return { manifest: JSON.parse(cached.json) as Manifest, etag };
      }
      const json = utf8.decode(await this.backend.read(this.manifestKey));
      this.remember(etag, json);
      return { manifest: JSON.parse(json) as Manifest, etag };
    }
    const res = await this.backend.readWithMeta(this.manifestKey);
    if (!res) return { manifest: emptyManifest(this.device), etag: undefined };
    const json = utf8.decode(res.data);
    if (res.etag) this.remember(res.etag, json);
    return { manifest: JSON.parse(json) as Manifest, etag: res.etag };
  }

  /**
   * Commit the manifest. Passes `prevEtag` so the backend rejects the write
   * (ConditionalWriteError) if another device committed in the meantime.
   * Returns the new etag.
   */
  async commit(manifest: Manifest, prevEtag?: string): Promise<string> {
    manifest.updatedBy = this.device;
    const json = JSON.stringify(manifest);
    const etag = await this.backend.write(this.manifestKey, utf8.encode(json), prevEtag);
    this.remember(etag, json);
    return etag;
  }

  private remember(etag: string, json: string): void {
    if (!this.cache) return;
    this.cache.entry = etag ? { etag, json } : null;
  }
}
