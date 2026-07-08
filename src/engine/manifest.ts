/** Helpers for creating and mutating the remote manifest. Pure, no I/O. */
import type { Manifest, ManifestEntry } from "../types.js";

export const MANIFEST_FORMAT_VERSION = 1;

export function emptyManifest(device: string): Manifest {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    updatedBy: device,
    entries: {},
  };
}

/** Next version number to assign for a path (monotonic per path). */
export function nextVersion(m: Manifest, path: string): number {
  return (m.entries[path]?.version ?? 0) + 1;
}

export function setEntry(m: Manifest, path: string, entry: ManifestEntry): void {
  m.entries[path] = entry;
}

/** Turn an entry into a tombstone while preserving version monotonicity. */
export function tombstone(m: Manifest, path: string): void {
  const prev = m.entries[path];
  m.entries[path] = {
    contentHash: "",
    blobKey: "",
    size: 0,
    mtime: prev?.mtime ?? 0,
    version: (prev?.version ?? 0) + 1,
    deleted: true,
  };
}
