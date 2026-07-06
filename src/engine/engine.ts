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
import type { FileMeta, Manifest, Op } from "../types.js";
import type { VaultAdapter } from "../vault/vault-adapter.js";
import { ConditionalWriteError, type StorageBackend } from "../backend/storage-backend.js";
import type { StateStore } from "./state-db.js";
import { reconcile } from "./reconciler.js";
import { cloneManifest, nextVersion, tombstone } from "./manifest.js";
import { ManifestStore } from "./manifest-store.js";
import { sha256 } from "../util/hash.js";
import { utf8 } from "../backend/http.js";

export interface SyncDeps {
  vault: VaultAdapter;
  backend: StorageBackend;
  state: StateStore;
  deviceId: string;
}

export interface SyncOptions {
  /** ISO timestamp for deterministic conflict-copy naming. */
  timestampIso: string;
  /** Skip re-hashing files whose size+mtime match the base (perf). */
  useMtimeShortcut?: boolean;
}

export interface SyncResult {
  ops: Op[];
  committed: boolean;
  conflict: boolean; // true if aborted due to a concurrent manifest write
}

/** Thrown internally when the manifest commit loses a concurrency race. */
export { ConditionalWriteError };

/** Scan the vault into a path→FileMeta map (reusing base hashes when unchanged). */
export async function scanVault(
  vault: VaultAdapter,
  base?: Map<string, { contentHash: string; size: number; mtime: number }>,
): Promise<Map<string, FileMeta>> {
  const paths = await vault.list();
  const out = new Map<string, FileMeta>();
  for (const path of paths) {
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

/** Opaque, stable blob key derived from a logical path. */
async function blobKeyForPath(path: string): Promise<string> {
  return "b-" + (await sha256(utf8.encode(path)));
}

export class SyncEngine {
  private readonly manifests: ManifestStore;

  constructor(private readonly deps: SyncDeps) {
    this.manifests = new ManifestStore(deps.backend, deps.deviceId);
  }

  async sync(opts: SyncOptions): Promise<SyncResult> {
    const { manifest, etag } = await this.manifests.load();
    const base = await this.deps.state.toMap();
    const local = await scanVault(this.deps.vault, opts.useMtimeShortcut ? base : undefined);

    const ops = reconcile(
      { local, base, remote: manifest },
      { conflictCopyPath: (p) => conflictCopyPath(p, this.deps.deviceId, opts.timestampIso) },
    );

    if (ops.length === 0) return { ops, committed: false, conflict: false };

    const working = cloneManifest(manifest);
    const stateMutations: Array<() => Promise<void>> = [];
    for (const op of ops) {
      await this.applyOp(op, working, stateMutations);
    }

    try {
      await this.manifests.commit(working, etag);
    } catch (err) {
      if (err instanceof ConditionalWriteError) {
        // Lost the race — leave State DB untouched; next cycle reconciles anew.
        return { ops, committed: false, conflict: true };
      }
      throw err;
    }

    for (const mutate of stateMutations) await mutate();
    return { ops, committed: true, conflict: false };
  }

  private async applyOp(
    op: Op,
    working: Manifest,
    stateMutations: Array<() => Promise<void>>,
  ): Promise<void> {
    const { vault, backend, state } = this.deps;

    switch (op.kind) {
      case "upload": {
        const data = await vault.readBinary(op.path);
        const contentHash = await sha256(data);
        const st = await vault.stat(op.path);
        const size = st?.size ?? data.byteLength;
        const mtime = st?.mtime ?? 0;
        const blobKey = working.entries[op.path]?.blobKey || (await blobKeyForPath(op.path));
        await backend.write(blobKey, data);
        const version = nextVersion(working, op.path);
        working.entries[op.path] = { contentHash, version, blobKey, size, mtime, deleted: false };
        stateMutations.push(() => state.put({ path: op.path, contentHash, size, mtime, version, blobKey }));
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
        break;
      }

      case "deleteRemote": {
        const entry = working.entries[op.path];
        if (entry?.blobKey) await backend.remove(entry.blobKey).catch(() => {});
        tombstone(working, op.path);
        stateMutations.push(() => state.delete(op.path));
        break;
      }

      case "deleteLocal": {
        await vault.remove(op.path);
        stateMutations.push(() => state.delete(op.path));
        break;
      }

      case "conflict": {
        const entry = working.entries[op.path];
        const remoteData = await backend.read(entry.blobKey);
        const localData = await vault.readBinary(op.path);
        // Save the local version as a conflict copy, take remote as canonical.
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
        // Upload the conflict copy so the other device sees it too.
        const copyHash = await sha256(localData);
        const copyStat = await vault.stat(op.conflictCopyPath);
        const copyBlobKey = await blobKeyForPath(op.conflictCopyPath);
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
        const version = nextVersion(working, op.to);
        working.entries[op.to] = { ...entry, version, deleted: false };
        tombstone(working, op.from);
        stateMutations.push(async () => {
          await state.delete(op.from);
          await state.put({
            path: op.to,
            contentHash: entry.contentHash,
            size: st?.size ?? entry.size,
            mtime: st?.mtime ?? entry.mtime,
            version,
            blobKey: entry.blobKey,
          });
        });
        break;
      }
    }
  }
}
