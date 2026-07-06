/**
 * Reads and commits the remote manifest as a single blob on the backend, using
 * the backend's etag for optimistic concurrency (docs/05-sync-engine.md). The
 * manifest is stored under a fixed key; content blobs live under separate keys.
 */
import type { Manifest } from "../types.js";
import { emptyManifest } from "./manifest.js";
import type { StorageBackend } from "../backend/storage-backend.js";
import { utf8 } from "../backend/http.js";

export const MANIFEST_KEY = "manifest.json";

export interface LoadedManifest {
  manifest: Manifest;
  /** Etag of the manifest blob as loaded, for a later conditional commit. */
  etag?: string;
}

export class ManifestStore {
  constructor(
    private readonly backend: StorageBackend,
    private readonly device: string,
  ) {}

  async load(): Promise<LoadedManifest> {
    const res = await this.backend.readWithMeta(MANIFEST_KEY);
    if (!res) return { manifest: emptyManifest(this.device), etag: undefined };
    const manifest = JSON.parse(utf8.decode(res.data)) as Manifest;
    return { manifest, etag: res.etag };
  }

  /**
   * Commit the manifest. Passes `prevEtag` so the backend rejects the write
   * (ConditionalWriteError) if another device committed in the meantime.
   * Returns the new etag.
   */
  async commit(manifest: Manifest, prevEtag?: string): Promise<string> {
    manifest.updatedBy = this.device;
    const data = utf8.encode(JSON.stringify(manifest));
    return this.backend.write(MANIFEST_KEY, data, prevEtag);
  }
}
