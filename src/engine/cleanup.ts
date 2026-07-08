/**
 * Maintenance: purge remote/state entries for paths that are currently excluded
 * from sync. When a path becomes excluded AFTER it was already synced (e.g. `.git/**`
 * added in 0.5.1, after an older build had uploaded the git repo), its manifest
 * entry, blob, and local-state record are otherwise never cleaned up — the engine
 * treats excluded paths as invisible, so they linger forever and bloat every
 * manifest load. This removes them, with a dry-run mode for a safe preview.
 */
import { ConditionalWriteError, type StorageBackend } from "../backend/storage-backend.js";
import type { ManifestStore } from "./manifest-store.js";
import type { StateStore } from "./state-db.js";

export interface CleanupResult {
  /** Excluded paths found in the manifest (removed, unless dryRun). */
  paths: string[];
  count: number;
  /** Total size (bytes) of the matched entries, per the manifest. */
  bytes: number;
  /** True if the manifest/state were actually modified (false for dryRun / no-op). */
  committed: boolean;
}

export interface CleanupOptions {
  manifests: ManifestStore;
  backend: StorageBackend;
  /** Predicate matching paths that should no longer be synced. */
  exclude: (path: string) => boolean;
  state: StateStore;
  dryRun: boolean;
  log?: (msg: string) => void;
}

const MAX_COMMIT_RETRIES = 5;

/**
 * Find manifest entries whose path is currently excluded and (unless dryRun) delete
 * their remote blobs, drop them from the manifest, and remove them from local state.
 * Never throws for a missing blob (idempotent). Retries the manifest commit if
 * another device wrote concurrently.
 */
export async function cleanupExcluded(opts: CleanupOptions): Promise<CleanupResult> {
  const { manifests, backend, exclude, state, dryRun } = opts;
  const log = opts.log ?? (() => {});

  let { manifest, etag } = await manifests.load();
  const matched = Object.keys(manifest.entries).filter(exclude);
  const bytes = matched.reduce((n, p) => n + (manifest.entries[p]?.size ?? 0), 0);
  log(`cleanup: ${matched.length} excluded entr${matched.length === 1 ? "y" : "ies"} in manifest`);

  if (dryRun || matched.length === 0) {
    return { paths: matched, count: matched.length, bytes, committed: false };
  }

  // Prune the manifest + blobs, committing with optimistic concurrency. On a
  // concurrent write, reload and recompute against the fresh manifest.
  let removed: string[] = [];
  for (let attempt = 0; ; attempt++) {
    removed = Object.keys(manifest.entries).filter(exclude);
    for (const path of removed) {
      const entry = manifest.entries[path];
      if (entry?.blobKey) await backend.remove(entry.blobKey).catch(() => {}); // 404 = already gone
      delete manifest.entries[path];
    }
    try {
      await manifests.commit(manifest, etag);
      break;
    } catch (err) {
      if (!(err instanceof ConditionalWriteError) || attempt >= MAX_COMMIT_RETRIES) throw err;
      const reloaded = await manifests.load();
      manifest = reloaded.manifest;
      etag = reloaded.etag;
      log(`cleanup: remote changed, retrying (${attempt + 1}/${MAX_COMMIT_RETRIES})`);
    }
  }

  // Drop from local state in a single batch.
  state.beginBatch();
  for (const path of removed) await state.delete(path);
  await state.flush();

  log(`cleanup: removed ${removed.length} entr${removed.length === 1 ? "y" : "ies"}`);
  return { paths: removed, count: removed.length, bytes, committed: true };
}
