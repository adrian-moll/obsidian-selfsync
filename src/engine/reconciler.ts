/**
 * The reconciler: a PURE 3-way diff (local vault vs. last-synced base vs. remote
 * manifest) that produces an ordered list of operations. This is the correctness
 * core of the sync engine and is exhaustively unit-tested (see
 * tests/reconciler.spec.ts and docs/05-sync-engine.md).
 *
 * No I/O, no clock, no randomness — conflict-copy naming is injected so the
 * function stays deterministic and testable.
 */
import type { FileMeta, Manifest, Op, StateEntry } from "../types.js";

export interface ReconcileInput {
  /** Current vault contents (absent key = file does not exist locally). */
  local: Map<string, FileMeta>;
  /** Last-synced snapshot (the merge base). */
  base: Map<string, StateEntry>;
  /** Remote manifest. */
  remote: Manifest;
}

export interface ReconcileOptions {
  /** Produce the conflict-copy path for a given canonical path. */
  conflictCopyPath: (path: string) => string;
  /** Detect renames (delete+create of identical content → move). Default true. */
  detectRenames?: boolean;
}

/** Hash of a file present locally, or null if absent. */
function localHashOf(input: ReconcileInput, path: string): string | null {
  return input.local.has(path) ? input.local.get(path)!.contentHash : null;
}

/** Hash at the merge base, or null if not present/synced at base. */
function baseHashOf(input: ReconcileInput, path: string): string | null {
  const b = input.base.get(path);
  return b && !b.deleted ? b.contentHash : null;
}

/** The remote state for a path, distinguishing present / tombstoned / absent. */
function remoteStateOf(
  input: ReconcileInput,
  path: string,
): { present: boolean; tombstoned: boolean; hash: string | null } {
  const r = input.remote.entries[path];
  if (!r) return { present: false, tombstoned: false, hash: null };
  if (r.deleted) return { present: false, tombstoned: true, hash: null };
  return { present: true, tombstoned: false, hash: r.contentHash };
}

export function reconcile(input: ReconcileInput, opts: ReconcileOptions): Op[] {
  const detectRenames = opts.detectRenames ?? true;
  const paths = new Set<string>([
    ...input.local.keys(),
    ...input.base.keys(),
    ...Object.keys(input.remote.entries),
  ]);

  const ops: Op[] = [];
  for (const path of paths) {
    const lHash = localHashOf(input, path);
    const bHash = baseHashOf(input, path);
    const remote = remoteStateOf(input, path);

    if (remote.present) {
      const rHash = remote.hash; // non-null when present
      const localChanged = lHash !== bHash;
      const remoteChanged = rHash !== bHash;

      if (!localChanged && !remoteChanged) continue; // in sync
      if (localChanged && !remoteChanged) {
        // Local edited (upload) or locally deleted a still-synced file (tombstone).
        ops.push(lHash !== null ? { kind: "upload", path } : { kind: "deleteRemote", path });
        continue;
      }
      if (!localChanged && remoteChanged) {
        ops.push({ kind: "download", path });
        continue;
      }
      // Both changed.
      if (lHash === rHash) continue; // converged to identical content
      if (lHash !== null) {
        ops.push({ kind: "conflict", path, conflictCopyPath: opts.conflictCopyPath(path) });
      } else {
        // Local deleted but remote edited → restore remote (data-safe).
        ops.push({ kind: "download", path });
      }
      continue;
    }

    if (remote.tombstoned) {
      // Explicit remote deletion.
      if (lHash === null) continue; // already gone locally
      if (lHash === bHash) {
        ops.push({ kind: "deleteLocal", path }); // unchanged locally → honor it
      } else {
        ops.push({ kind: "upload", path }); // locally edited after the delete → keep local
      }
      continue;
    }

    // Remote ABSENT (no entry at all). A missing entry is NOT a deletion — never
    // delete local data on mere absence (NFR2; safe across manifest resets and
    // layout changes). If the file exists locally, (re)upload it.
    if (lHash !== null) ops.push({ kind: "upload", path });
    // else: nothing anywhere → no-op.
  }

  return detectRenames ? applyRenameDetection(ops, input) : ops;
}

/**
 * Collapse a (deleteRemote A) + (upload B) pair with identical content into a
 * single move A→B. Best-effort: if undetected, the fallback delete+upload is
 * still correct, just less efficient.
 */
function applyRenameDetection(ops: Op[], input: ReconcileInput): Op[] {
  const deletes = ops.filter((o): o is Extract<Op, { kind: "deleteRemote" }> => o.kind === "deleteRemote");
  const uploads = ops.filter((o): o is Extract<Op, { kind: "upload" }> => o.kind === "upload");
  if (!deletes.length || !uploads.length) return ops;

  const consumed = new Set<Op>();
  const moves: Op[] = [];

  for (const del of deletes) {
    const delHash = input.base.get(del.path)?.contentHash;
    if (delHash == null) continue;
    const match = uploads.find(
      (u) =>
        !consumed.has(u) &&
        !input.base.has(u.path) && // the upload target is genuinely new
        input.local.get(u.path)?.contentHash === delHash,
    );
    if (match) {
      consumed.add(del);
      consumed.add(match);
      moves.push({ kind: "move", from: del.path, to: match.path });
    }
  }

  if (!moves.length) return ops;
  return [...ops.filter((o) => !consumed.has(o)), ...moves];
}
