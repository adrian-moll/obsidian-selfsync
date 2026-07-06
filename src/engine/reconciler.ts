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

/** Hash on the remote, or null if absent/tombstoned. */
function remoteHashOf(input: ReconcileInput, path: string): string | null {
  const r = input.remote.entries[path];
  return r && !r.deleted ? r.contentHash : null;
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
    const rHash = remoteHashOf(input, path);

    const localChanged = lHash !== bHash;
    const remoteChanged = rHash !== bHash;

    // Nothing changed on either side → no-op.
    if (!localChanged && !remoteChanged) continue;

    // Only local changed.
    if (localChanged && !remoteChanged) {
      ops.push(
        lHash !== null
          ? { kind: "upload", path }
          : { kind: "deleteRemote", path },
      );
      continue;
    }

    // Only remote changed.
    if (!localChanged && remoteChanged) {
      ops.push(
        rHash !== null
          ? { kind: "download", path }
          : { kind: "deleteLocal", path },
      );
      continue;
    }

    // Both changed.
    if (lHash === rHash) continue; // converged to the same content → no-op

    if (lHash !== null && rHash !== null) {
      // Genuine edit/edit conflict → keep both.
      ops.push({ kind: "conflict", path, conflictCopyPath: opts.conflictCopyPath(path) });
      continue;
    }

    // Delete-vs-edit: prefer keeping content (data-safe). The surviving edit
    // resurrects the file; the user can re-delete if desired.
    if (lHash === null && rHash !== null) {
      ops.push({ kind: "download", path });
      continue;
    }
    // lHash !== null && rHash === null
    ops.push({ kind: "upload", path });
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
