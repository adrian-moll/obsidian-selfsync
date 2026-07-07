/**
 * Sync engine orchestration (M1): a full sync cycle — load manifest, scan vault,
 * reconcile, execute transfers, and commit the manifest with optimistic
 * concurrency. No encryption yet (M3); blobs are stored as-is.
 *
 * Concurrency (M1 policy): if the manifest commit is rejected because another
 * device wrote first (ConditionalWriteError), this cycle aborts WITHOUT touching
 * the local State DB, so the next cycle re-loads the newer manifest and
 * reconciles cleanly. Any blob uploaded this cycle whose manifest entry didn't
 * commit is a harmless orphan (GC later). Local State DB updates are applied only
 * AFTER a successful commit.
 */
import type { FileMeta, Manifest, ManifestEntry, Op } from "../types.js";
import type { VaultAdapter } from "../vault/vault-adapter.js";
import { ConditionalWriteError, type StorageBackend } from "../backend/storage-backend.js";
import type { StateStore } from "./state-db.js";
import { reconcile } from "./reconciler.js";
import { cloneManifest, nextVersion, tombstone } from "./manifest.js";
import { ManifestStore } from "./manifest-store.js";
import type { BlobNaming } from "./naming.js";
import type { BaseStore } from "./base-store.js";
import { isMergeableText, mergeText } from "./merge.js";
import { sha256 } from "../util/hash.js";
import { utf8 } from "../backend/http.js";

export interface SyncDeps {
  vault: VaultAdapter;
  backend: StorageBackend;
  state: StateStore;
  deviceId: string;
  /** Maps vault paths to backend blob keys (mirror vs opaque layout). */
  naming: BlobNaming;
  /** Optional: last-synced content store enabling 3-way auto-merge of text. */
  baseStore?: BaseStore;
}

export interface SyncOptions {
  /** ISO timestamp for deterministic conflict-copy naming. */
  timestampIso: string;
  /** Skip re-hashing files whose size+mtime match the base (perf). */
  useMtimeShortcut?: boolean;
  /** Paths matching this are never synced (uploaded/downloaded/deleted). */
  exclude?: (path: string) => boolean;
}

export interface SyncResult {
  ops: Op[];
  committed: boolean;
  conflict: boolean; // true if aborted due to a concurrent manifest write
  /** Paths whose concurrent edits were auto-merged (no conflict copy). */
  merged: string[];
  /** Conflict-copy paths created for genuinely overlapping edits this cycle. */
  conflictCopies: string[];
  /** ALL conflict-copy files currently present in the vault (any device). */
  existingConflicts: string[];
}

/** Whether a vault path is a SelfSync conflict copy (e.g. `note (conflict …).md`). */
export function isConflictCopy(path: string): boolean {
  return /\(conflict [^)]*\)/.test(path);
}

/** Map a conflict-copy path back to its canonical file (inverse of conflictCopyPath). */
export function canonicalPathOf(conflictCopyPath: string): string {
  return conflictCopyPath.replace(/ \(conflict [^)]*\)/, "");
}

interface Outcomes {
  merged: string[];
  conflictCopies: string[];
}

/** Thrown internally when the manifest commit loses a concurrency race. */
export { ConditionalWriteError };

/** Scan the vault into a path→FileMeta map (reusing base hashes when unchanged). */
export async function scanVault(
  vault: VaultAdapter,
  base?: Map<string, { contentHash: string; size: number; mtime: number }>,
  exclude: (path: string) => boolean = () => false,
): Promise<Map<string, FileMeta>> {
  const paths = await vault.list();
  const out = new Map<string, FileMeta>();
  for (const path of paths) {
    if (exclude(path)) continue;
    const st = await vault.stat(path);
    if (!st) continue;
    const prior = base?.get(path);
    if (prior && prior.size === st.size && prior.mtime === st.mtime) {
      out.set(path, { path, contentHash: prior.contentHash, size: st.size, mtime: st.mtime });
      continue;
    }
    const data = await vault.readBinary(path);
    const contentHash = await sha256(data);
    out.set(path, { path, contentHash, size: st.size, mtime: st.mtime });
  }
  return out;
}

/** Build the conflict-copy path, e.g. `note (conflict <device> <iso>).md`. */
export function conflictCopyPath(path: string, device: string, timestampIso: string): string {
  const safeStamp = timestampIso.replace(/:/g, "-");
  const suffix = ` (conflict ${device} ${safeStamp})`;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > slash + 1) return path.slice(0, dot) + suffix + path.slice(dot);
  return path + suffix;
}

export class SyncEngine {
  private readonly manifests: ManifestStore;

  constructor(private readonly deps: SyncDeps) {
    this.manifests = new ManifestStore(deps.backend, deps.deviceId, deps.naming.manifestKey);
  }

  async sync(opts: SyncOptions): Promise<SyncResult> {
    const exclude = opts.exclude ?? (() => false);
    const { manifest, etag } = await this.manifests.load();
    const baseAll = await this.deps.state.toMap();
    const local = await scanVault(this.deps.vault, opts.useMtimeShortcut ? baseAll : undefined, exclude);
    const existingConflicts = [...local.keys()].filter(isConflictCopy);

    // Hide excluded paths from reconciliation (from local, base, and remote) so
    // they are never uploaded/downloaded/deleted. The full manifest is still
    // committed below, so any pre-existing excluded remote entries are preserved.
    const base = new Map([...baseAll].filter(([p]) => !exclude(p)));
    const remoteEntries: Record<string, ManifestEntry> = {};
    for (const [p, e] of Object.entries(manifest.entries)) if (!exclude(p)) remoteEntries[p] = e;
    const remoteForReconcile: Manifest = { ...manifest, entries: remoteEntries };

    const ops = reconcile(
      { local, base, remote: remoteForReconcile },
      { conflictCopyPath: (p) => conflictCopyPath(p, this.deps.deviceId, opts.timestampIso) },
    );

    const outcomes: Outcomes = { merged: [], conflictCopies: [] };
    if (ops.length === 0) {
      return { ops, committed: false, conflict: false, merged: [], conflictCopies: [], existingConflicts };
    }

    const working = cloneManifest(manifest);
    const stateMutations: Array<() => Promise<void>> = [];
    for (const op of ops) {
      await this.applyOp(op, working, stateMutations, outcomes);
    }

    try {
      await this.manifests.commit(working, etag);
    } catch (err) {
      if (err instanceof ConditionalWriteError) {
        // Lost the race — leave State DB untouched; next cycle reconciles anew.
        return { ops, committed: false, conflict: true, merged: [], conflictCopies: [], existingConflicts };
      }
      throw err;
    }

    for (const mutate of stateMutations) await mutate();
    return {
      ops,
      committed: true,
      conflict: false,
      merged: outcomes.merged,
      conflictCopies: outcomes.conflictCopies,
      // Include copies created this cycle (the scan predates their creation).
      existingConflicts: [...new Set([...existingConflicts, ...outcomes.conflictCopies])],
    };
  }

  /** Store the agreed content of a text file so future conflicts can 3-way merge. */
  private async rememberBase(path: string, data: ArrayBuffer): Promise<void> {
    if (this.deps.baseStore && isMergeableText(path)) await this.deps.baseStore.set(path, data);
  }

  /** Drop a file's stored base content. */
  private async forgetBase(path: string): Promise<void> {
    if (this.deps.baseStore) await this.deps.baseStore.delete(path);
  }

  private async applyOp(
    op: Op,
    working: Manifest,
    stateMutations: Array<() => Promise<void>>,
    outcomes: Outcomes,
  ): Promise<void> {
    const { vault, backend, state } = this.deps;

    switch (op.kind) {
      case "upload": {
        const data = await vault.readBinary(op.path);
        const contentHash = await sha256(data);
        const st = await vault.stat(op.path);
        const size = st?.size ?? data.byteLength;
        const mtime = st?.mtime ?? 0;
        const blobKey = await this.deps.naming.blobKey(op.path);
        await backend.write(blobKey, data);
        const version = nextVersion(working, op.path);
        working.entries[op.path] = { contentHash, version, blobKey, size, mtime, deleted: false };
        stateMutations.push(() => state.put({ path: op.path, contentHash, size, mtime, version, blobKey }));
        stateMutations.push(() => this.rememberBase(op.path, data));
        break;
      }

      case "download": {
        const entry = working.entries[op.path];
        const data = await backend.read(entry.blobKey);
        await vault.writeBinary(op.path, data);
        const st = await vault.stat(op.path);
        stateMutations.push(() =>
          state.put({
            path: op.path,
            contentHash: entry.contentHash,
            size: entry.size,
            mtime: st?.mtime ?? entry.mtime,
            version: entry.version,
            blobKey: entry.blobKey,
          }),
        );
        stateMutations.push(() => this.rememberBase(op.path, data));
        break;
      }

      case "deleteRemote": {
        const entry = working.entries[op.path];
        if (entry?.blobKey) await backend.remove(entry.blobKey).catch(() => {});
        tombstone(working, op.path);
        stateMutations.push(() => state.delete(op.path));
        stateMutations.push(() => this.forgetBase(op.path));
        break;
      }

      case "deleteLocal": {
        await vault.remove(op.path);
        stateMutations.push(() => state.delete(op.path));
        stateMutations.push(() => this.forgetBase(op.path));
        break;
      }

      case "conflict": {
        const entry = working.entries[op.path];
        const remoteData = await backend.read(entry.blobKey);
        const localData = await vault.readBinary(op.path);

        // Try a 3-way auto-merge for text notes edited in different regions.
        if (this.deps.baseStore && isMergeableText(op.path)) {
          const baseData = await this.deps.baseStore.get(op.path);
          if (baseData) {
            const merged = mergeText(utf8.decode(baseData), utf8.decode(localData), utf8.decode(remoteData));
            if (merged !== null) {
              const mergedBuf = utf8.encode(merged);
              await vault.writeBinary(op.path, mergedBuf);
              const contentHash = await sha256(mergedBuf);
              const st2 = await vault.stat(op.path);
              const size = st2?.size ?? mergedBuf.byteLength;
              const mtime = st2?.mtime ?? 0;
              const blobKey = await this.deps.naming.blobKey(op.path);
              await backend.write(blobKey, mergedBuf);
              const version = nextVersion(working, op.path);
              working.entries[op.path] = { contentHash, version, blobKey, size, mtime, deleted: false };
              stateMutations.push(() => state.put({ path: op.path, contentHash, size, mtime, version, blobKey }));
              stateMutations.push(() => this.rememberBase(op.path, mergedBuf));
              outcomes.merged.push(op.path);
              break;
            }
          }
        }

        // Keep both: remote becomes canonical, local saved as a conflict copy.
        await vault.writeBinary(op.conflictCopyPath, localData);
        await vault.writeBinary(op.path, remoteData);
        const st = await vault.stat(op.path);
        stateMutations.push(() =>
          state.put({
            path: op.path,
            contentHash: entry.contentHash,
            size: entry.size,
            mtime: st?.mtime ?? entry.mtime,
            version: entry.version,
            blobKey: entry.blobKey,
          }),
        );
        stateMutations.push(() => this.rememberBase(op.path, remoteData));
        outcomes.conflictCopies.push(op.conflictCopyPath);
        // Upload the conflict copy so the other device sees it too.
        const copyHash = await sha256(localData);
        const copyStat = await vault.stat(op.conflictCopyPath);
        const copyBlobKey = await this.deps.naming.blobKey(op.conflictCopyPath);
        await backend.write(copyBlobKey, localData);
        const copyVersion = nextVersion(working, op.conflictCopyPath);
        working.entries[op.conflictCopyPath] = {
          contentHash: copyHash,
          version: copyVersion,
          blobKey: copyBlobKey,
          size: copyStat?.size ?? localData.byteLength,
          mtime: copyStat?.mtime ?? 0,
          deleted: false,
        };
        stateMutations.push(() =>
          state.put({
            path: op.conflictCopyPath,
            contentHash: copyHash,
            size: copyStat?.size ?? localData.byteLength,
            mtime: copyStat?.mtime ?? 0,
            version: copyVersion,
            blobKey: copyBlobKey,
          }),
        );
        break;
      }

      case "move": {
        const entry = working.entries[op.from];
        const st = await vault.stat(op.to);
        const newBlobKey = await this.deps.naming.blobKey(op.to);
        // Relocate the remote blob when its key changes (real rename in mirror
        // mode; cheap server-side rename in opaque mode).
        if (entry.blobKey !== newBlobKey) {
          await backend.move(entry.blobKey, newBlobKey);
        }
        const version = nextVersion(working, op.to);
        working.entries[op.to] = { ...entry, blobKey: newBlobKey, version, deleted: false };
        tombstone(working, op.from);
        stateMutations.push(async () => {
          await state.delete(op.from);
          await state.put({
            path: op.to,
            contentHash: entry.contentHash,
            size: st?.size ?? entry.size,
            mtime: st?.mtime ?? entry.mtime,
            version,
            blobKey: newBlobKey,
          });
          // Carry the base content along with the rename.
          if (this.deps.baseStore) {
            const b = await this.deps.baseStore.get(op.from);
            if (b) await this.deps.baseStore.set(op.to, b);
            await this.deps.baseStore.delete(op.from);
          }
        });
        break;
      }
    }
  }
}
