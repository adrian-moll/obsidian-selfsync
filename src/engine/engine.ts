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
import { nextVersion, tombstone } from "./manifest.js";
import { ManifestStore } from "./manifest-store.js";
import type { BlobNaming } from "./naming.js";
import type { BaseStore } from "./base-store.js";
import { isMergeableText, mergeText } from "./merge.js";
import { isEnabledPluginList, isObsidianConfig, mergeEnabledLists } from "./config-merge.js";
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
  /** Called after each op executes, for progress display. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Called on phase transitions BEFORE the op loop (loading the remote index,
   * scanning/hashing the vault, reconciling) — the phases that otherwise show a
   * long, silent "Syncing…" on a large or heavily-changed vault. During the scan
   * it reports a running file count. The caller should throttle UI updates.
   */
  onPhase?: (detail: string) => void;
  /**
   * Optional diagnostic sink for the sync phases (manifest load, vault scan,
   * reconcile, per-chunk commit). The engine is otherwise silent, so without
   * this a crash mid-sync leaves no trace of where it died.
   */
  log?: (msg: string) => void;
  /**
   * Skip files larger than this many bytes (local or remote). Reading a whole large
   * file into memory can OOM/crash Obsidian (notably on Android). 0/undefined = no
   * limit. Skipped paths are left untouched on both sides (never deleted).
   */
  maxFileBytes?: number;
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
  /** Paths skipped this cycle because they exceed the max file size. */
  skippedLarge: string[];
  /** Paths whose op failed this cycle (e.g. a server error) and were skipped so
   *  the rest of the sync could proceed. Retried on the next cycle. */
  failed: string[];
}

/** Format a byte count as megabytes for diagnostic logs. */
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Blobs larger than this are downloaded in ranged chunks and streamed to disk
 * (append), instead of read whole. Reading/writing a whole large file — and, on
 * mobile, base64-encoding it across the native bridge — can OOM/crash Obsidian
 * (the reported Android large-file crash). 8 MiB keeps each transfer well within
 * a phone's heap while limiting the number of round-trips.
 */
const DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Device-local staging area for in-progress large downloads. Lives inside
 * SelfSync's own plugin folder, which is always excluded from sync
 * (`DEFAULT_EXCLUDES`), so partial files are never themselves synced. A staged
 * file's byte length is the resume offset; a `.etag` sidecar records the blob
 * version so a resume never stitches two different remote versions together.
 */
const DOWNLOAD_STAGING_DIR = ".obsidian/plugins/selfsync/incoming";

/** Whether a vault path is a SelfSync conflict copy (e.g. `note (conflict …).md`). */
export function isConflictCopy(path: string): boolean {
  return /\(conflict [^)]*\)/.test(path);
}

/** Map a conflict-copy path back to its canonical file (inverse of conflictCopyPath). */
export function canonicalPathOf(conflictCopyPath: string): string {
  return conflictCopyPath.replace(/ \(conflict [^)]*\)/, "");
}

/** The manifest keys an op may mutate — used to snapshot/rollback a failed op. */
function opPaths(op: Op): string[] {
  switch (op.kind) {
    case "move":
      return [op.from, op.to];
    case "conflict":
      return [op.path, op.conflictCopyPath];
    default:
      return [op.path];
  }
}

/** Human-readable path label for logs and the failed-paths list. */
function opLabel(op: Op): string {
  return op.kind === "move" ? `${op.from} -> ${op.to}` : op.path;
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
  maxFileBytes = 0,
  onSkipLarge?: (path: string, size: number) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, FileMeta>> {
  const paths = await vault.list();
  const out = new Map<string, FileMeta>();
  const total = paths.length;
  let done = 0;
  for (const path of paths) {
    done++;
    onProgress?.(done, total);
    if (exclude(path)) continue;
    const st = await vault.stat(path);
    if (!st) continue;
    // Unchanged since the last sync (size + mtime match) → reuse the stored hash
    // with NO read. This MUST come before the size guard: a large file that was
    // merely DOWNLOADED here (never edited) then reconciles to a no-op instead of
    // being reported "skipped (too large)" on every sync, and large remote
    // updates/deletes still propagate to this device.
    const prior = base?.get(path);
    if (prior && prior.size === st.size && prior.mtime === st.mtime) {
      out.set(path, { path, contentHash: prior.contentHash, size: st.size, mtime: st.mtime });
      continue;
    }
    // New or locally-changed: we must READ it to hash. Guard BEFORE readBinary so
    // an oversized file we'd have to upload is never materialized in memory — it's
    // left in place on all sides (never read, never propagated, never deleted).
    if (maxFileBytes > 0 && st.size > maxFileBytes) {
      onSkipLarge?.(path, st.size);
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
    const callerExclude = opts.exclude ?? (() => false);
    // Always hide our own download staging area from reconciliation — those
    // partial files are an engine implementation detail and must never sync,
    // regardless of the caller's exclude config.
    const exclude = (p: string): boolean => p.startsWith(`${DOWNLOAD_STAGING_DIR}/`) || callerExclude(p);
    const maxFileBytes = opts.maxFileBytes ?? 0;
    const log = opts.log ?? (() => {});
    const phase = opts.onPhase ?? (() => {});

    phase("Loading remote index…");
    let { manifest, etag } = await this.manifests.load();
    log(`manifest loaded: ${Object.keys(manifest.entries).length} entries`);

    // `maxFileBytes` caps only what we hold WHOLE in memory: uploads (scanned
    // below) and the non-streamed download fallback. Downloads themselves are
    // streamed in ranged chunks (fetchBlobToVault), so large remote files are no
    // longer skipped — only oversized LOCAL files (which can't be chunk-uploaded)
    // land in `skipped`.
    const skipped = new Set<string>();

    phase("Scanning vault…");
    const local = await scanVault(
      this.deps.vault,
      opts.useMtimeShortcut ? await this.deps.state.toMap() : undefined,
      exclude,
      maxFileBytes,
      (p) => skipped.add(p),
      (d, t) => phase(`Scanning ${d}/${t}…`),
    );
    log(`scanned vault: ${local.size} files, ${skipped.size} oversized skipped`);
    const existingConflicts = [...local.keys()].filter(isConflictCopy);

    // Oversized paths are hidden on ALL three sides (local/base/remote) so they are
    // simply left in place — never read, never propagated, never deleted.
    const effectiveExclude = skipped.size > 0 ? (p: string) => exclude(p) || skipped.has(p) : exclude;

    // Hide excluded paths from reconciliation; the full manifest is still committed
    // (so pre-existing excluded remote entries are preserved).
    const filterRemote = (m: Manifest): Manifest => {
      const entries: Record<string, ManifestEntry> = {};
      for (const [p, e] of Object.entries(m.entries)) if (!effectiveExclude(p)) entries[p] = e;
      return { ...m, entries };
    };
    const reconcileAgainst = async (m: Manifest): Promise<Op[]> => {
      const base = new Map([...(await this.deps.state.toMap())].filter(([p]) => !effectiveExclude(p)));
      return reconcile(
        { local, base, remote: filterRemote(m) },
        { conflictCopyPath: (p) => conflictCopyPath(p, this.deps.deviceId, opts.timestampIso) },
      );
    };

    phase("Reconciling…");
    let ops = await reconcileAgainst(manifest);
    log(`reconciled: ${ops.length} ops`);

    const outcomes: Outcomes = { merged: [], conflictCopies: [] };
    const appliedOps: Op[] = [];
    const failed: string[] = [];
    const result = (conflict: boolean): SyncResult => ({
      ops: appliedOps,
      committed: appliedOps.length > 0,
      conflict,
      merged: outcomes.merged,
      conflictCopies: outcomes.conflictCopies,
      existingConflicts: [...new Set([...existingConflicts, ...outcomes.conflictCopies])],
      skippedLarge: [...skipped],
      failed: [...new Set(failed)],
    });

    if (ops.length === 0) return result(false);

    // Commit the manifest in chunks so progress survives a mid-sync collision:
    // committed chunks update the State DB, so a conflict only re-does the
    // uncommitted remainder instead of the whole batch.
    const CHUNK = 100;
    const MAX_CONFLICT_RELOADS = 5;
    let done = 0;
    let conflictReloads = 0;

    while (ops.length > 0) {
      const chunk = ops.splice(0, CHUNK);
      // Apply ops directly to `manifest`: no code path reuses the pre-chunk
      // manifest after a mutation (success reassigns nothing; a conflict reloads
      // a fresh manifest below; any other error aborts the whole sync). Cloning
      // the whole manifest per chunk was O(N²) and a large-vault memory hog.
      const chunkMutations: Array<() => Promise<void>> = [];
      const succeeded: Op[] = [];
      // Progress is reported per file as it transfers (not once per committed
      // chunk), so the count advances smoothly through a large sync instead of
      // jumping in CHUNK-sized steps. The transfer is the slow part; the manifest
      // commit that follows is quick. The caller throttles UI updates. `total`
      // (files remaining after this chunk + this chunk) stays fixed across the
      // chunk, so the count is monotonic within it.
      const chunkStart = done;
      const chunkTotal = chunkStart + chunk.length + ops.length;
      for (let i = 0; i < chunk.length; i++) {
        const op = chunk[i];
        // Snapshot the manifest entries + queued mutations this op may touch, so a
        // failure (e.g. a server 500 on one file) rolls back cleanly and we can
        // skip just that file instead of aborting the whole sync. (Since 0.10.0
        // the manifest is mutated in place, so partial mutations must be undone.)
        const mutBefore = chunkMutations.length;
        const backup = opPaths(op).map((p) => [p, manifest.entries[p]] as const);
        try {
          await this.applyOp(op, manifest, chunkMutations, outcomes, maxFileBytes, log);
          succeeded.push(op);
        } catch (err) {
          if (err instanceof ConditionalWriteError) throw err;
          for (const [p, prev] of backup) {
            if (prev === undefined) delete manifest.entries[p];
            else manifest.entries[p] = prev;
          }
          chunkMutations.length = mutBefore;
          const msg = err instanceof Error ? err.message : String(err);
          failed.push(opLabel(op));
          log(`  ✗ ${opLabel(op)}: ${msg}`);
        }
        opts.onProgress?.(chunkStart + i + 1, chunkTotal);
      }

      try {
        etag = await this.manifests.commit(manifest, etag);
      } catch (err) {
        if (err instanceof ConditionalWriteError) {
          if (++conflictReloads > MAX_CONFLICT_RELOADS) return result(true);
          // Another device committed first — reload and re-plan the remaining
          // work against the fresh manifest (already-committed chunks are now in
          // the State DB, so they reconcile to no-ops).
          const reloaded = await this.manifests.load();
          manifest = reloaded.manifest;
          etag = reloaded.etag;
          ops = await reconcileAgainst(manifest);
          continue;
        }
        throw err;
      }

      // Persist the State DB once for the whole chunk instead of once per op —
      // the per-op whole-DB serialization was the dominant O(N²) cost (and the
      // large-vault Android OOM). Per-chunk granularity keeps the same crash
      // safety: committed chunks are durable, an interrupted one re-runs.
      this.deps.state.beginBatch();
      for (const mutate of chunkMutations) await mutate();
      await this.deps.state.flush();
      appliedOps.push(...succeeded);
      done += chunk.length;
      // (progress was already reported per-file in the loop above)
      log(`committed chunk: ${done}/${done + ops.length}`);
    }

    return result(false);
  }

  /**
   * Download a blob into the vault. For blobs over {@link DOWNLOAD_CHUNK_BYTES}
   * (when the backend supports ranged reads) the data is streamed to disk in
   * chunks via appendBinary, so the whole file is never held in memory — this is
   * what prevents the Android OOM on large downloads. Returns the full buffer for
   * small single-shot reads (so a text base can be remembered), or null when the
   * blob was streamed (large binaries need no base).
   */
  private async fetchBlobToVault(
    path: string,
    blobKey: string,
    size: number,
    maxWholeBytes: number,
    log: (msg: string) => void,
  ): Promise<ArrayBuffer | null> {
    const { vault, backend } = this.deps;
    // An empty file has no bytes to fetch — write it directly and skip the GET.
    // Some WebDAV servers/proxies return HTTP 500 on GET of a 0-byte object, so
    // reading it would fail for no reason.
    if (size === 0) {
      const empty = new ArrayBuffer(0);
      await vault.writeBinary(path, empty);
      return empty;
    }
    if (size > DOWNLOAD_CHUNK_BYTES && backend.head && backend.readRange) {
      const meta = await backend.head(blobKey).catch(() => null);
      if (meta?.acceptRanges) {
        await this.streamBlobToVault(path, blobKey, meta.size || size, meta.etag, log);
        return null;
      }
      log(`  ↳ ranged read unavailable; would read whole blob`);
    }
    // Streaming wasn't possible (small blob, or the server has no range support).
    // A blob up to one chunk is always safe to read whole; a genuinely large one
    // that we can't stream would risk the very OOM we avoid, so refuse it when it
    // exceeds the whole-in-memory cap — per-op resilience reports it and retries.
    if (size > DOWNLOAD_CHUNK_BYTES && maxWholeBytes > 0 && size > maxWholeBytes) {
      throw new Error(
        `blob ${mb(size)} MB exceeds the ${mb(maxWholeBytes)} MB in-memory limit and the server does not support ranged reads`,
      );
    }
    const data = await backend.read(blobKey);
    await vault.writeBinary(path, data);
    return data;
  }

  /**
   * Stream a large blob into the vault in ranged chunks, staging to a device-local
   * file so an interrupted transfer RESUMES instead of restarting. The staged
   * file's size is the resume offset; a `.etag` sidecar guards against the remote
   * blob changing mid-resume. On completion the staged file is renamed onto the
   * final path (a metadata move — never re-read, so mobile-safe). Requires the
   * backend's `head`/`readRange` (checked by the caller).
   */
  private async streamBlobToVault(
    path: string,
    blobKey: string,
    total: number,
    etag: string | undefined,
    log: (msg: string) => void,
  ): Promise<void> {
    const { vault, backend } = this.deps;
    const staging = `${DOWNLOAD_STAGING_DIR}/${await sha256(utf8.encode(path))}`;
    const sidecar = `${staging}.etag`;

    // Resume only if a partial exists for the SAME remote version; else start clean.
    const existing = (await vault.stat(staging))?.size ?? 0;
    const priorEtag = existing > 0 ? await this.readTextFile(sidecar) : null;
    const canResume = existing > 0 && existing < total && !!etag && !!priorEtag && priorEtag === etag;

    let offset = 0;
    if (canResume) {
      offset = existing;
      log(`  ↳ resuming at ${mb(offset)}/${mb(total)} MB`);
    } else {
      // Discard any stale/mismatched partial so we never stitch two versions.
      if (existing > 0) {
        await vault.remove(staging).catch(() => {});
        await vault.remove(sidecar).catch(() => {});
      }
      if (etag) await vault.writeBinary(sidecar, utf8.encode(etag));
    }

    while (offset < total) {
      const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, total) - 1;
      const part = await backend.readRange!(blobKey, offset, end);
      if (offset === 0) await vault.writeBinary(staging, part);
      else await vault.appendBinary(staging, part);
      offset = end + 1;
      log(`  ↳ streamed ${mb(offset)}/${mb(total)} MB`);
    }

    // Move the completed file into place, then drop the sidecar. Remove any
    // existing destination first — rename won't overwrite on some platforms
    // (e.g. Windows) and a download may be replacing an older local copy.
    if (await vault.exists(path)) await vault.remove(path).catch(() => {});
    await vault.rename(staging, path);
    await vault.remove(sidecar).catch(() => {});
  }

  /** Read a small text file, or null if it doesn't exist. */
  private async readTextFile(path: string): Promise<string | null> {
    if (!(await this.deps.vault.exists(path))) return null;
    try {
      return utf8.decode(await this.deps.vault.readBinary(path));
    } catch {
      return null;
    }
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
    maxFileBytes: number,
    log: (msg: string) => void = () => {},
  ): Promise<void> {
    const { vault, backend, state } = this.deps;

    switch (op.kind) {
      case "upload": {
        log(`upload ${op.path}`);
        const data = await vault.readBinary(op.path);
        const contentHash = await sha256(data);
        const st = await vault.stat(op.path);
        const size = st?.size ?? data.byteLength;
        const mtime = st?.mtime ?? 0;
        const blobKey = await this.deps.naming.blobKey(op.path);
        log(`  ↳ read ${mb(size)} MB; writing`);
        await backend.write(blobKey, data);
        const version = nextVersion(working, op.path);
        working.entries[op.path] = { contentHash, version, blobKey, size, mtime, deleted: false };
        stateMutations.push(() => state.put({ path: op.path, contentHash, size, mtime, version, blobKey }));
        stateMutations.push(() => this.rememberBase(op.path, data));
        break;
      }

      case "download": {
        const entry = working.entries[op.path];
        log(`download ${op.path} (${mb(entry.size)} MB)`);
        const data = await this.fetchBlobToVault(op.path, entry.blobKey, entry.size, maxFileBytes, log);
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
        // `data` is null when the blob was streamed to disk in chunks (large
        // files); those are binary, never mergeable text, so there's no base to
        // remember. Small blobs return their buffer so text bases are kept.
        if (data) stateMutations.push(() => this.rememberBase(op.path, data));
        break;
      }

      case "deleteRemote": {
        log(`deleteRemote ${op.path}`);
        const entry = working.entries[op.path];
        if (entry?.blobKey) await backend.remove(entry.blobKey).catch(() => {});
        tombstone(working, op.path);
        stateMutations.push(() => state.delete(op.path));
        stateMutations.push(() => this.forgetBase(op.path));
        break;
      }

      case "deleteLocal": {
        log(`deleteLocal ${op.path}`);
        await vault.remove(op.path);
        stateMutations.push(() => state.delete(op.path));
        stateMutations.push(() => this.forgetBase(op.path));
        break;
      }

      case "conflict": {
        const entry = working.entries[op.path];
        log(`conflict ${op.path} (remote ${mb(entry.size)} MB); reading remote+local`);
        // Skip the GET for a 0-byte remote (empty file) — some servers 500 on it.
        const remoteData = entry.size === 0 ? new ArrayBuffer(0) : await backend.read(entry.blobKey);
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

        // `.obsidian` config is settings, not documents — auto-resolve instead of
        // keeping both (D3 config amendment). Enabled-plugin lists union-merge;
        // any other config file takes the newest side. No conflict copy either way.
        if (isObsidianConfig(op.path)) {
          await this.resolveConfigConflict(op.path, entry, localData, remoteData, working, stateMutations, outcomes, log);
          break;
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
        log(`move ${op.from} -> ${op.to}`);
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

  /**
   * Resolve a conflict on an `.obsidian` config file WITHOUT a keep-both copy.
   * Enabled-plugin lists union-merge (both devices' plugins stay enabled); any
   * other config file takes the newest side by mtime. Both outcomes update the
   * manifest + State DB and are reported as `merged` (no conflict copy).
   */
  private async resolveConfigConflict(
    path: string,
    entry: ManifestEntry,
    localData: ArrayBuffer,
    remoteData: ArrayBuffer,
    working: Manifest,
    stateMutations: Array<() => Promise<void>>,
    outcomes: Outcomes,
    log: (msg: string) => void,
  ): Promise<void> {
    const { vault, backend, state } = this.deps;

    // 1) Enabled-plugin lists → union merge (combine both devices' plugins).
    if (isEnabledPluginList(path)) {
      const merged = mergeEnabledLists(utf8.decode(localData), utf8.decode(remoteData));
      if (merged !== null) {
        const buf = utf8.encode(merged);
        await vault.writeBinary(path, buf);
        const contentHash = await sha256(buf);
        const st = await vault.stat(path);
        const size = st?.size ?? buf.byteLength;
        const mtime = st?.mtime ?? 0;
        const blobKey = await this.deps.naming.blobKey(path);
        await backend.write(blobKey, buf);
        const version = nextVersion(working, path);
        working.entries[path] = { contentHash, version, blobKey, size, mtime, deleted: false };
        stateMutations.push(() => state.put({ path, contentHash, size, mtime, version, blobKey }));
        outcomes.merged.push(path);
        log(`  ↳ merged plugin list (union)`);
        return;
      }
      // couldn't parse → fall through to newest-wins
    }

    // 2) Any other .obsidian config → newest-wins by mtime (no conflict copy).
    const st = await vault.stat(path);
    const localMtime = st?.mtime ?? 0;
    if (localMtime > (entry.mtime ?? 0)) {
      // Local is newer → publish it, overwriting the remote copy.
      const contentHash = await sha256(localData);
      const size = st?.size ?? localData.byteLength;
      const blobKey = await this.deps.naming.blobKey(path);
      await backend.write(blobKey, localData);
      const version = nextVersion(working, path);
      working.entries[path] = { contentHash, version, blobKey, size, mtime: localMtime, deleted: false };
      stateMutations.push(() => state.put({ path, contentHash, size, mtime: localMtime, version, blobKey }));
      log(`  ↳ config newest-wins: kept local`);
    } else {
      // Remote is newer (or the same) → adopt it locally.
      await vault.writeBinary(path, remoteData);
      const st2 = await vault.stat(path);
      stateMutations.push(() =>
        state.put({
          path,
          contentHash: entry.contentHash,
          size: entry.size,
          mtime: st2?.mtime ?? entry.mtime,
          version: entry.version,
          blobKey: entry.blobKey,
        }),
      );
      log(`  ↳ config newest-wins: took remote`);
    }
    outcomes.merged.push(path);
  }
}
