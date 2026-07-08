/**
 * VaultAdapter implementation backed by Obsidian's DataAdapter. This is the only
 * place in the sync path that touches the "obsidian" module; it is never imported
 * by unit tests. Works on desktop and mobile.
 */
import { type App, type DataAdapter, normalizePath } from "obsidian";
import type { VaultAdapter, VaultFileStat } from "./vault-adapter.js";

export class ObsidianVaultAdapter implements VaultAdapter {
  private readonly adapter: DataAdapter;

  constructor(app: App) {
    this.adapter = app.vault.adapter;
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const listing = await this.adapter.list(dir);
      for (const file of listing.files) out.push(file);
      for (const folder of listing.folders) await walk(folder);
    };
    await walk("/");
    return out;
  }

  async stat(path: string): Promise<VaultFileStat | null> {
    const st = await this.adapter.stat(normalizePath(path));
    if (!st || st.type !== "file") return null;
    return { size: st.size, mtime: st.mtime };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(normalizePath(path));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    const norm = normalizePath(path);
    await this.ensureParentDir(norm);
    await this.adapter.writeBinary(norm, data);
  }

  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    const norm = normalizePath(path);
    await this.ensureParentDir(norm);
    // appendBinary is available since Obsidian 1.12.3 (our minAppVersion).
    await this.adapter.appendBinary(norm, data);
  }

  async remove(path: string): Promise<void> {
    const norm = normalizePath(path);
    await this.adapter.remove(norm);
    await this.pruneEmptyParents(norm);
  }

  /** Remove now-empty ancestor folders after deleting a file (best-effort). */
  private async pruneEmptyParents(normalizedPath: string): Promise<void> {
    let dir = this.parentOf(normalizedPath);
    while (dir) {
      let listing;
      try {
        listing = await this.adapter.list(dir);
      } catch {
        return;
      }
      if (listing.files.length > 0 || listing.folders.length > 0) return; // not empty
      try {
        await this.adapter.rmdir(dir, false);
      } catch {
        return;
      }
      dir = this.parentOf(dir);
    }
  }

  private parentOf(p: string): string | null {
    const i = p.lastIndexOf("/");
    return i > 0 ? p.slice(0, i) : null; // null → root-level (nothing to prune)
  }

  async rename(from: string, to: string): Promise<void> {
    const dest = normalizePath(to);
    await this.ensureParentDir(dest);
    await this.adapter.rename(normalizePath(from), dest);
  }

  /**
   * Ensure every ancestor folder of a (normalized) path exists. Obsidian's mobile
   * adapter rejects writes into a missing folder ("Parent folder doesn't exist"),
   * so we create each level before writing a downloaded/renamed file.
   */
  private async ensureParentDir(normalizedPath: string): Promise<void> {
    const idx = normalizedPath.lastIndexOf("/");
    if (idx <= 0) return; // vault root — nothing to create
    const dir = normalizedPath.slice(0, idx);
    const parts = dir.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.adapter.exists(cur))) {
        try {
          await this.adapter.mkdir(cur);
        } catch {
          // Racy create or already exists between exists() and mkdir() — ignore.
        }
      }
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(normalizePath(path));
  }
}
