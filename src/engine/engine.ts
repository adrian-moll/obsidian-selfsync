/**
 * Sync engine orchestration. M0 wires the pieces together and can PLAN a sync
 * (scan + reconcile); actually executing transfers against a real backend lands
 * in M1. Everything here is platform-agnostic and driven by injected
 * dependencies (VaultAdapter, StorageBackend, StateStore).
 */
import type { FileMeta, Manifest, Op } from "../types.js";
import type { VaultAdapter } from "../vault/vault-adapter.js";
import type { StorageBackend } from "../backend/storage-backend.js";
import type { StateStore } from "./state-db.js";
import { reconcile } from "./reconciler.js";
import { sha256 } from "../util/hash.js";

export interface SyncDeps {
  vault: VaultAdapter;
  backend: StorageBackend;
  state: StateStore;
  deviceId: string;
}

export interface PlanOptions {
  /** The remote manifest just fetched from the backend. */
  manifest: Manifest;
  /** ISO timestamp used for deterministic conflict-copy naming. */
  timestampIso: string;
  /** Skip re-hashing files whose size+mtime match the base (perf). */
  useMtimeShortcut?: boolean;
}

/**
 * Scan the vault into a path→FileMeta map. When `base` is supplied and
 * useMtimeShortcut is on, files whose size+mtime are unchanged reuse the base
 * hash instead of being re-read (large-vault performance, NFR3).
 */
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

/**
 * Build the conflict-copy path, e.g. `note (conflict <device> <iso>).md`.
 * Pure/deterministic — device and timestamp are injected.
 */
export function conflictCopyPath(path: string, device: string, timestampIso: string): string {
  const safeStamp = timestampIso.replace(/[:]/g, "-");
  const suffix = ` (conflict ${device} ${safeStamp})`;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // Only treat as an extension if the dot is after the last slash and not a
  // leading dot (dotfile).
  if (dot > slash + 1) {
    return path.slice(0, dot) + suffix + path.slice(dot);
  }
  return path + suffix;
}

/** Plan a sync: scan the vault, load the base, and reconcile against the manifest. */
export async function planSync(deps: SyncDeps, opts: PlanOptions): Promise<Op[]> {
  const base = await deps.state.toMap();
  const local = await scanVault(deps.vault, opts.useMtimeShortcut ? base : undefined);
  return reconcile(
    { local, base, remote: opts.manifest },
    { conflictCopyPath: (p) => conflictCopyPath(p, deps.deviceId, opts.timestampIso) },
  );
}

/**
 * Execute a planned op list. Not implemented in M0 — the transfer manager,
 * journalling, and manifest commit land in M1 (docs/09-roadmap.md).
 */
export async function executeOps(_deps: SyncDeps, _ops: Op[]): Promise<never> {
  throw new Error("SelfSync: transfer execution is not implemented yet (M0 scaffold).");
}
