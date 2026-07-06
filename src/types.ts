/**
 * Shared, platform-agnostic types for the SelfSync engine.
 *
 * IMPORTANT: this module (and everything it is imported by on the sync path)
 * must NOT import from "obsidian" — the pure engine is unit-tested in Node.
 */

/** High-level UI/engine status. */
export type SyncStatusState = "idle" | "syncing" | "error" | "conflicts";

/** Metadata for a file as it currently exists locally in the vault. */
export interface FileMeta {
  path: string; // vault-relative logical path
  contentHash: string; // SHA-256 hex of the content
  size: number;
  mtime: number; // ms since epoch; used to skip re-hashing unchanged files
}

/** A file's state at the last successful sync (the 3-way merge base). */
export interface StateEntry {
  path: string;
  contentHash: string;
  size: number;
  mtime: number;
  version: number; // manifest version last seen for this file
  blobKey: string; // opaque backend key at last sync
  deleted?: boolean; // known-synced tombstone
}

/** A single entry in the remote manifest. */
export interface ManifestEntry {
  contentHash: string;
  version: number; // monotonically bumped per change
  blobKey: string; // opaque; where the content blob lives on the backend
  size: number;
  mtime: number;
  deleted?: boolean; // tombstone (drives delete propagation)
}

/** The remote manifest — the source of truth for "what exists remotely". */
export interface Manifest {
  formatVersion: number;
  updatedBy: string; // device id of the last writer
  entries: Record<string, ManifestEntry>; // key = logical vault path
}

/**
 * A reconciliation operation. The reconciler emits only actionable ops
 * (no-ops are omitted).
 */
export type Op =
  | { kind: "upload"; path: string }
  | { kind: "download"; path: string }
  | { kind: "deleteRemote"; path: string }
  | { kind: "deleteLocal"; path: string }
  | { kind: "conflict"; path: string; conflictCopyPath: string }
  | { kind: "move"; from: string; to: string };
