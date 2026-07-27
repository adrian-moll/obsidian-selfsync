/**
 * VaultAdapter implementation backed by the Node filesystem, for the headless
 * client (docker/Dockerfile.cli). It is the Node-side twin of
 * ObsidianVaultAdapter: same contract, same semantics, no "obsidian" import — so
 * the engine can't tell which one it is running against.
 *
 * Two things differ from the Obsidian adapter because the host is a real fs:
 *   - Paths are validated to stay inside the vault root. Obsidian's DataAdapter
 *     is already confined to the vault; here a malformed manifest entry (`../`,
 *     an absolute path) would otherwise write anywhere the process can reach.
 *   - list() prunes `.git` and `.trash` AT THE ROOT ONLY, matching the
 *     root-anchored DEFAULT_EXCLUDES globs — walking a large `.git` on every
 *     sync cycle is pure waste. Nested `.git` folders are NOT pruned, because
 *     `.git/**` doesn't exclude them either.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { VaultAdapter, VaultFileStat } from "./vault-adapter.js";

/** Root-level directory names skipped by the walk (always in DEFAULT_EXCLUDES). */
const DEFAULT_PRUNE_ROOTS = [".git", ".trash"];

export interface NodeVaultAdapterOptions {
  /** Absolute path of the vault directory on the host. */
  root: string;
  /** Root-level directory names to skip while listing. */
  pruneRoots?: string[];
}

/** Thrown when a vault path would resolve outside the vault root. */
export class PathEscapeError extends Error {
  constructor(path: string) {
    super(`Path escapes the vault root: ${path}`);
    this.name = "PathEscapeError";
  }
}

export class NodeVaultAdapter implements VaultAdapter {
  private readonly root: string;
  private readonly pruneRoots: Set<string>;

  constructor(opts: NodeVaultAdapterOptions) {
    this.root = nodePath.resolve(opts.root);
    this.pruneRoots = new Set(opts.pruneRoots ?? DEFAULT_PRUNE_ROOTS);
  }

  /**
   * Vault path (POSIX, relative) → absolute host path, rejecting anything that
   * would land outside the root.
   */
  private abs(path: string): string {
    const clean = path.replace(/^\/+/, "");
    const full = nodePath.resolve(this.root, ...clean.split("/"));
    if (full !== this.root && !full.startsWith(this.root + nodePath.sep)) {
      throw new PathEscapeError(path);
    }
    return full;
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dirAbs: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return; // vanished or unreadable mid-walk — nothing to sync from it
      }
      for (const entry of entries) {
        // Symlinks and device/socket/fifo entries are not vault content; following
        // a symlink could also escape the root or loop forever.
        if (entry.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (prefix === "" && this.pruneRoots.has(entry.name)) continue;
          await walk(nodePath.join(dirAbs, entry.name), rel);
        } else if (entry.isFile()) {
          out.push(rel);
        }
      }
    };
    await walk(this.root, "");
    return out;
  }

  async stat(path: string): Promise<VaultFileStat | null> {
    try {
      const st = await fs.stat(this.abs(path));
      if (!st.isFile()) return null;
      // Integer ms: scanVault compares mtime for EXACT equality against this
      // device's own State DB, so the value must be stable across stats — a
      // fractional ns-precision mtimeMs would round-trip differently via JSON.
      return { size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
      return null;
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.abs(path));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const full = this.abs(path);
    await fs.mkdir(nodePath.dirname(full), { recursive: true });
    await fs.writeFile(full, new Uint8Array(data));
  }

  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    const full = this.abs(path);
    await fs.mkdir(nodePath.dirname(full), { recursive: true });
    // Plain append: streamBlobToVault uses the staged file's byte length as the
    // resume offset, so this must not buffer, truncate, or write via a temp file.
    await fs.appendFile(full, new Uint8Array(data));
  }

  async remove(path: string): Promise<void> {
    const full = this.abs(path);
    await fs.rm(full, { force: true });
    await this.pruneEmptyParents(full);
  }

  /** Remove now-empty ancestor directories after a delete (best-effort). */
  private async pruneEmptyParents(fullPath: string): Promise<void> {
    let dir = nodePath.dirname(fullPath);
    while (dir !== this.root && dir.startsWith(this.root + nodePath.sep)) {
      try {
        await fs.rmdir(dir); // fails with ENOTEMPTY if it still holds anything
      } catch {
        return;
      }
      dir = nodePath.dirname(dir);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const dest = this.abs(to);
    const src = this.abs(from);
    await fs.mkdir(nodePath.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    await this.pruneEmptyParents(src);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }
}
